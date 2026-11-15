#!/usr/bin/python3
import os
import sys


os.execv('/usr/bin/podman', ['/usr/bin/podman', '--remote', '--url', 'unix:///run/dev-workspace-podman/podman.sock', *sys.argv[1:]])
