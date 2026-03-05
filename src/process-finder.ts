/**
 * Process Finder – Detects Antigravity's language_server process,
 * extracts the CSRF token and discovers the API port.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import * as process from 'process';

const execAsync = promisify(exec);

export interface ProcessInfo {
    port: number;
    csrfToken: string;
}

interface ParsedProcess {
    pid: number;
    extensionPort: number;
    csrfToken: string;
}

/**
 * Finds the running Antigravity language_server process, extracts
 * connection parameters, and discovers the correct API port.
 */
export async function findAntigravityProcess(workspacePath?: string): Promise<ProcessInfo | null> {
    const processName = getProcessName();

    try {
        const parsed = await findProcess(processName, workspacePath);
        if (!parsed) { return null; }

        const ports = await getListeningPorts(parsed.pid);
        if (ports.length === 0) { return null; }

        const workingPort = await findWorkingPort(ports, parsed.csrfToken);
        if (!workingPort) { return null; }

        return { port: workingPort, csrfToken: parsed.csrfToken };
    } catch {
        return null;
    }
}

// ─── Internals ──────────────────────────────────────────────────────

function getProcessName(): string {
    if (process.platform === 'win32') {
        return 'language_server_windows_x64.exe';
    }
    if (process.platform === 'darwin') {
        return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
    }
    return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
}

async function findProcess(name: string, workspacePath?: string): Promise<ParsedProcess | null> {
    const parentPid = process.pid;

    const cmd = process.platform === 'win32'
        ? `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${name}'\\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json"`
        : `ps -ww -e -o pid,ppid,args`; // Get all processes with PID, PPID, and full command

    try {
        const { stdout } = await execAsync(cmd);
        return parseProcessOutput(stdout, workspacePath, parentPid);
    } catch {
        return null; // Execution failed
    }
}

function parseProcessOutput(stdout: string, workspacePath?: string, parentPid?: number): ParsedProcess | null {
    if (process.platform === 'win32') {
        return parseWindows(stdout, workspacePath, parentPid);
    }
    return parseUnix(stdout, workspacePath, parentPid);
}

function parseWindows(stdout: string, workspacePath?: string, parentPid?: number): ParsedProcess | null {
    try {
        let data = JSON.parse(stdout.trim());
        const wsId = workspacePath ? toWorkspaceId(workspacePath) : null;

        if (Array.isArray(data)) {
            // Filter to Antigravity processes only
            data = data.filter((d: any) => {
                const cmd = (d.CommandLine || '').toLowerCase();
                return /--app_data_dir\s+antigravity\b/i.test(d.CommandLine || '')
                    || cmd.includes('\\antigravity\\')
                    || cmd.includes('/antigravity/');
            });
            if (data.length === 0) { return null; }

            // 1. Exact PPID match (perfect isolation per-profile/window)
            let target = parentPid ? data.find((d: any) => d.ParentProcessId === parentPid) : null;

            // 2. Fallback to workspace ID match
            if (!target && wsId) {
                target = data.find((d: any) => (d.CommandLine || '').includes(wsId));
            }

            // 3. Fallback to first available
            if (!target) {
                target = data[0];
            }
            data = target;
        }

        const cmdLine = data.CommandLine || '';
        const pid = data.ProcessId;
        if (!pid) { return null; }

        const port = cmdLine.match(/--extension_server_port[=\s]+(\d+)/);
        const token = cmdLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
        if (!token?.[1]) { return null; }

        return {
            pid,
            extensionPort: port ? parseInt(port[1], 10) : 0,
            csrfToken: token[1],
        };
    } catch {
        return null;
    }
}

/**
 * Converts a workspace folder path to the workspace_id format
 * used by the language server's --workspace_id argument.
 * e.g. "/Users/me/My Project" → "file_Users_me_My_20Project"
 */
function toWorkspaceId(folderPath: string): string {
    return 'file' + folderPath.replace(/ /g, '_20').replace(/\//g, '_');
}

function parseUnix(stdout: string, workspacePath?: string, parentPid?: number): ParsedProcess | null {
    const wsId = workspacePath ? toWorkspaceId(workspacePath) : null;

    // We only care about language_server lines spanning extension ports
    const lines = stdout.split('\n')
        .filter(l => l.includes('--extension_server_port'))
        .map(l => l.trim())
        .filter(l => l.length > 0);

    const processes = lines.map(line => {
        // Look for PID PPID COMMAND format based on ps -ww -e -o pid,ppid,args
        const match = line.match(/^(\d+)\s+(\d+)?\s+(.*)$/);
        if (match) {
            return {
                pid: parseInt(match[1], 10),
                ppid: match[2] ? parseInt(match[2], 10) : undefined,
                cmd: match[3]
            };
        }
        // Fallback for unexpected formats
        const parts = line.split(/\s+/);
        return {
            pid: parseInt(parts[0], 10),
            ppid: undefined,
            cmd: line.substring(parts[0].length).trim()
        };
    });

    if (processes.length === 0) { return null; }

    // 1. Exact PPID match (perfect isolation per-profile/window)
    let target = parentPid ? processes.find(p => p.ppid === parentPid) : null;

    // 2. Fallback to workspace ID match
    if (!target && wsId) {
        target = processes.find(p => p.cmd.includes(wsId));
    }

    // 3. Ultimate fallback
    if (!target) {
        target = processes[0];
    }

    const portMatch = target.cmd.match(/--extension_server_port[=\s]+(\d+)/);
    const tokenMatch = target.cmd.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);

    return {
        pid: target.pid,
        extensionPort: portMatch ? parseInt(portMatch[1], 10) : 0,
        csrfToken: tokenMatch ? tokenMatch[1] : '',
    };
}

async function getListeningPorts(pid: number): Promise<number[]> {
    try {
        const cmd = process.platform === 'darwin'
            ? `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
            : process.platform === 'win32'
                ? `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`
                : `ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid} 2>/dev/null`;

        const { stdout } = await execAsync(cmd);
        return parsePortOutput(stdout, pid);
    } catch {
        return [];
    }
}

function parsePortOutput(stdout: string, pid: number): number[] {
    const ports: number[] = [];

    if (process.platform === 'win32') {
        try {
            const data = JSON.parse(stdout.trim());
            const arr = Array.isArray(data) ? data : [data];
            for (const p of arr) {
                if (typeof p === 'number' && !ports.includes(p)) { ports.push(p); }
            }
        } catch { /* ignore */ }
        return ports.sort((a, b) => a - b);
    }

    // macOS / Linux – parse lsof output
    const lsofRegex = new RegExp(
        `^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`,
        'gim'
    );
    let match;
    while ((match = lsofRegex.exec(stdout)) !== null) {
        const p = parseInt(match[1], 10);
        if (!ports.includes(p)) { ports.push(p); }
    }

    // Linux – parse ss output
    // Format: LISTEN  0  128  *:42100  *:*  users:(("language_server",pid=1234,fd=5))
    for (const line of stdout.split('\n')) {
        if (!line.includes(`pid=${pid}`)) { continue; }
        const cols = line.trim().split(/\s+/);
        // ss columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port Process
        const localAddr = cols[3];
        if (!localAddr) { continue; }
        const portMatch = localAddr.match(/:(\d+)$/);
        if (portMatch) {
            const p = parseInt(portMatch[1], 10);
            if (!ports.includes(p)) { ports.push(p); }
        }
    }

    return ports.sort((a, b) => a - b);
}

async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
        const ok = await testPort(port, csrfToken);
        if (ok) { return port; }
    }
    return null;
}

/**
 * Try HTTP first; if it fails, fall back to HTTPS on the same port.
 */
async function testPort(port: number, csrfToken: string): Promise<boolean> {
    const ok = await testPortWithProtocol(port, csrfToken, 'http');
    if (ok) { return true; }
    return testPortWithProtocol(port, csrfToken, 'https');
}

function testPortWithProtocol(port: number, csrfToken: string, protocol: 'http' | 'https'): Promise<boolean> {
    return new Promise(resolve => {
        const lib = protocol === 'https' ? https : http;
        const req = lib.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': csrfToken,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: 3000,
            },
            res => {
                let body = '';
                res.on('data', (chunk: Buffer) => (body += chunk));
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { JSON.parse(body); resolve(true); } catch { resolve(false); }
                    } else { resolve(false); }
                });
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(JSON.stringify({ wrapper_data: {} }));
        req.end();
    });
}
