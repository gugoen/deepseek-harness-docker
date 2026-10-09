# Activate the Python virtual environment this container was pointed at.
#
# The entrypoint already does this for the harness process and every shell the
# agent runs. Two more entry points need it:
#
#   * a login shell rebuilds PATH from /etc/profile before sourcing
#     /etc/profile.d/*.sh, which would otherwise drop the environment;
#   * `docker exec` starts a fresh process from the image configuration, so it
#     never saw the entrypoint's environment — only DSH_PYTHON_VENV itself.
#
# The file is inert unless an environment is configured, and it never fails a
# shell: an unreadable or missing mount leaves PATH untouched.
#
# Keep the resolution order in step with docker/python-runtime.mjs.

_dsh_python_venv="${DSH_PYTHON_VENV:-}"
if [ -z "${_dsh_python_venv}" ] && [ -x /opt/dsh-python/bin/python3 ]; then
  _dsh_python_venv=/opt/dsh-python
fi

if [ -n "${_dsh_python_venv}" ] && [ -x "${_dsh_python_venv}/bin/python3" ]; then
  case ":${PATH}:" in
    *":${_dsh_python_venv}/bin:"*) ;;
    *) PATH="${_dsh_python_venv}/bin:${PATH}"; export PATH ;;
  esac
  VIRTUAL_ENV="${_dsh_python_venv}"
  export VIRTUAL_ENV
  unset PYTHONHOME
fi

unset _dsh_python_venv
