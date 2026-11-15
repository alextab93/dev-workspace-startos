#!/usr/bin/python3
import signal
import subprocess
import sys
import time


def main():
    stopping = False
    def stop(number, frame):
        nonlocal stopping
        stopping = True
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, stop)
    processes = []
    try:
        processes.append(subprocess.Popen(['/usr/local/bin/workspace-packages', 'serve'], stdin=subprocess.DEVNULL))
        processes.append(subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', '/etc/ssh/sshd_config'], stdin=subprocess.DEVNULL))
        while not stopping and all(process.poll() is None for process in processes):
            time.sleep(0.2)
        return 0 if stopping else 1
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
        for process in reversed(processes):
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    sys.exit(main())
