import { accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { failure } from './files'

/** Python's stdlib PTY works when Eating itself has no controlling terminal. */
export function terminalCommand(command: readonly string[]): { executable: string; args: string[] } {
  if (process.platform === 'win32') throw failure('ANDROID_TERMINAL_UNAVAILABLE', '当前执行端尚未提供 Windows PTY；完整非终端ADB仍可使用。', 'not-sent', 409)
  let python: string | undefined
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) { const file = resolve(dir, 'python3'); try { accessSync(file, constants.X_OK); python = file; break } catch { /* Executable discovery only. */ } }
  if (!python) throw failure('ANDROID_TERMINAL_UNAVAILABLE', '交互终端需要执行端已有的Python3标准库，未自动安装。', 'not-sent', 409)
  return { executable: python, args: ['-u', '-c', String.raw`
import errno, json, os, pty, select, signal, sys, fcntl, struct, termios
command=json.loads(sys.argv[1])
pid,master=pty.fork()
if pid==0:
    os.execvpe(command[0],command,os.environ)
def forward(sig,frame):
    try: os.killpg(pid,sig)
    except ProcessLookupError: pass
    if sig in (signal.SIGTERM,signal.SIGHUP):
        try: os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError: pass
for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP): signal.signal(sig,forward)
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
inputs=[master,0]
try:
    while master in inputs:
        try: ready,_,_=select.select(inputs,[],[])
        except InterruptedError: continue
        for fd in ready:
            try: chunk=os.read(fd,65536)
            except OSError as error:
                if fd==master and error.errno==errno.EIO: chunk=b''
                else: raise
            if not chunk:
                inputs.remove(fd)
                if fd==0:
                    try: os.write(master,b'\x04')
                    except OSError: pass
                continue
            if fd==master: os.write(1,chunk)
            else: os.write(master,chunk)
finally: os.close(master)
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128+os.WTERMSIG(status))
`, JSON.stringify(command)] }
}
