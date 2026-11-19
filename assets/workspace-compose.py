#!/usr/bin/python3
import argparse
import fcntl
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys


PROJECTS = Path('/home/dev/projects')
REGISTRY = Path('/run/dev-workspace-podman/projects.sqlite3')


def paths(directory, filename):
    if not directory or not filename or any(ord(c) < 32 for c in directory + filename):
        raise ValueError('Use a local project directory and Compose filename.')
    if Path(directory).is_absolute() or Path(filename).is_absolute():
        raise ValueError('Use relative project and Compose file paths.')
    project = (PROJECTS / directory).resolve(strict=True)
    compose = (project / filename).resolve(strict=True)
    if PROJECTS.resolve() != PROJECTS or not project.is_relative_to(PROJECTS) or not compose.is_relative_to(project) or not compose.is_file():
        raise ValueError('Select a Compose file inside a local project.')
    return project, compose


def containers(name, *args):
    return subprocess.check_output([
        '/usr/local/bin/podman', 'ps', '--all', '--filter',
        'label=io.podman.compose.project=' + name, *args,
    ], text=True, timeout=30, stderr=subprocess.DEVNULL).strip()


def operate(db, operation, name, directory=None, filename=None, autostart=None):
    if not re.fullmatch('[a-z0-9][a-z0-9_-]{0,62}', name):
        raise ValueError('Use a lowercase Compose project name of up to 63 characters.')
    with (REGISTRY.parent / ('compose-' + name + '.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run_project(db, operation, name, directory, filename, autostart)


def run_project(db, operation, name, directory, filename, autostart):
    row = db.execute('SELECT directory, filename, autostart FROM projects WHERE name=?', (name,)).fetchone()
    if operation == 'register':
        paths(directory, filename)
        if row and row[:2] != (directory, filename):
            raise ValueError('Unregister this name before selecting another project.')
        db.execute('INSERT OR REPLACE INTO projects VALUES (?, ?, ?, ?)', (name, directory, filename, autostart == 'on'))
    elif not row:
        raise ValueError('Unknown project.')
    elif operation == 'unregister':
        if containers(name, '--filter', 'status=running', '--quiet'):
            raise ValueError('Stop the project before unregistering it.')
        db.execute('DELETE FROM projects WHERE name=?', (name,))
    elif operation == 'status':
        print(containers(name, '--format', '{{.Names}}\t{{.Status}}') or 'No project containers.')
    elif operation == 'logs':
        for container in containers(name, '--format', '{{.Names}}').splitlines():
            print(container, flush=True)
            subprocess.run(['/usr/local/bin/podman', 'logs', '--tail', '50', container],
                           stderr=subprocess.STDOUT, check=True, timeout=30)
    elif operation != 'boot' or row[2]:
        project, compose = paths(*row[:2])
        args = {'boot': ['up', '-d'], 'start': ['up', '-d'], 'stop': ['stop']}[operation]
        command = ['/usr/bin/podman-compose', '-p', name, '-f', str(compose)]
        subprocess.run([*command, *args],
                       cwd=project, check=True, timeout=300,
                       stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        if operation in ('boot', 'start'):
            expected = subprocess.check_output([*command, 'config', '--services'], cwd=project,
                                               text=True, timeout=30, stderr=subprocess.DEVNULL)
            running = containers(name, '--filter', 'status=running', '--format',
                                 '{{.Label "com.docker.compose.service"}}')
            if not expected.strip() or set(expected.splitlines()) - set(running.splitlines()):
                raise ValueError('Some services did not start. Check the project status and logs.')
        elif operation == 'stop' and containers(name, '--filter', 'status=running', '--quiet'):
            raise ValueError('Some project containers are still running.')
    db.commit()
    if operation == 'unregister':
        print(name, 'unregistered. Containers and volumes retained.')
    elif operation != 'logs':
        enabled = autostart == 'on' if operation == 'register' else row[2]
        print(name, 'autostart=' + ('on' if enabled else 'off'))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='operation', required=True)
    register = commands.add_parser('register')
    register.add_argument('name')
    register.add_argument('directory')
    register.add_argument('filename')
    register.add_argument('autostart', choices=['on', 'off'])
    for command in ('start', 'stop', 'status', 'logs', 'unregister'):
        commands.add_parser(command).add_argument('name')
    commands.add_parser('list')
    commands.add_parser('boot')
    args = parser.parse_args()
    if os.geteuid() != 1000:
        raise ValueError('Run workspace-compose as dev.')
    if not (REGISTRY.parent / 'podman.sock').is_socket():
        raise ValueError('Enable Podman and start the workspace engine first.')
    os.umask(0o077)
    with sqlite3.connect(REGISTRY, timeout=330) as db:
        db.execute('CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, directory TEXT, filename TEXT, autostart INTEGER)')
        if args.operation == 'list':
            for name, directory, filename, enabled in db.execute('SELECT * FROM projects ORDER BY name'):
                print(name, directory, filename, 'autostart=' + ('on' if enabled else 'off'), sep='\t')
        elif args.operation == 'boot':
            for name, in db.execute('SELECT name FROM projects WHERE autostart=1 ORDER BY name').fetchall():
                try:
                    operate(db, 'boot', name)
                except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
                    db.rollback()
                    print('Could not start registered project:', name, file=sys.stderr)
        else:
            operate(db, **vars(args))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
    except (OSError, sqlite3.Error, subprocess.SubprocessError):
        sys.exit('Project operation failed. Check the local path, Compose file, port availability and engine status.')
