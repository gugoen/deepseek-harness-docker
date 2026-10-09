# Interactive shell conveniences for the DeepSeek Harness container.
# Sourced from /etc/bash.bashrc and ~/.bashrc; `ll` and `get` are also real
# commands in /usr/local/bin so non-interactive shells can use them.

alias ll='ls -alF --color=auto --group-directories-first'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'
alias ..='cd ..'
alias ...='cd ../..'
alias dsh-web='node /app/apps/cli/lib/bin.js web'

export EDITOR="${EDITOR:-vim}"
export PAGER="${PAGER:-less}"
export LESS="${LESS:--R}"
