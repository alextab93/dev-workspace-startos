export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
if [ -n "${BASH_VERSION:-}" ] && [ -f "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
fi
