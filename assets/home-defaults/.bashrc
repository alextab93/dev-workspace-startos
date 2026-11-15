export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"
case $- in
    *i*) eval "$(mise activate bash)" ;;
esac
