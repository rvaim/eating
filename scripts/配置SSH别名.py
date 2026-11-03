#!/usr/bin/env python3
import getpass
import ipaddress
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import warnings


class SetupError(Exception):
    pass


def require_outside(path, project_root):
    resolved = path.resolve()
    if resolved == project_root or project_root in resolved.parents:
        raise SetupError("配置目标位于项目目录内，已拒绝写入。")
    return resolved


def quote_path(path):
    value = str(path)
    if any(character in value for character in "\r\n\x00$%"):
        raise SetupError("路径包含SSH特殊展开字符，不能用于此配置。")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def validate_host(value):
    if any(character in value for character in "\r\n\x00$%"):
        raise SetupError("服务器地址格式无效。")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if len(value) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in value.rstrip(".").split(".")):
            raise SetupError("请填写纯IP或主机名，不要填写URL、端口或用户名。")
        return value


def existing_bytes(path):
    if path.is_symlink():
        raise SetupError("SSH配置是符号链接，脚本不会自动修改。")
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise SetupError("现有SSH配置类型或大小不适合自动修改。")
    return path.read_bytes()


def check_alias(original, alias):
    if original is None:
        return
    try:
        lines = original.decode("utf-8").splitlines()
        for line in lines:
            tokens = shlex.split(line, comments=True)
            if tokens and tokens[0].lower() == "host" and alias.lower() in [token.lower() for token in tokens[1:]]:
                raise SetupError("该别名已存在于SSH主配置，请使用新的别名。")
    except (UnicodeError, ValueError):
        raise SetupError("无法安全解析现有SSH配置，未自动修改。")


def setup(home=None, project_root=None, ask=input, private_ask=getpass.getpass):
    home = Path.home() if home is None else Path(home)
    project_root = Path(__file__).resolve().parent.parent if project_root is None else Path(project_root).resolve()
    ssh_directory = home / ".ssh"
    include_directory = ssh_directory / "config.d"
    for directory in [ssh_directory, include_directory]:
        require_outside(directory, project_root)
        if directory.is_symlink() or directory.exists() and not directory.is_dir():
            raise SetupError("SSH配置目录不是普通目录，未自动修改。")
    main_config = ssh_directory / "config"
    require_outside(main_config, project_root)
    original = existing_bytes(main_config)

    print("本脚本只配置本机SSH别名，不连接服务器、不生成或读取私钥内容。")
    print("地址、用户名、端口和密钥路径输入时不显示；留空密钥路径可使用SSH Agent或登录时输入密码。")
    alias = ask("SSH别名（字母开头，可含数字、横线、下划线）：").strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", alias):
        raise SetupError("别名格式无效。")
    check_alias(original, alias)
    target = include_directory / ("eating-" + alias + ".conf")
    require_outside(target, project_root)
    if target.exists() or target.is_symlink():
        raise SetupError("该别名的独立配置已存在，脚本不会覆盖，请换一个别名。")

    hostname = validate_host(private_ask("服务器IP或主机名（隐藏输入）：").strip())
    username = private_ask("登录用户名（隐藏输入）：").strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?", username):
        raise SetupError("登录用户名格式无效。")
    port_text = private_ask("SSH端口（隐藏输入，回车使用22）：").strip() or "22"
    if not port_text.isascii() or not port_text.isdigit() or not 1 <= int(port_text) <= 65535:
        raise SetupError("端口需为1至65535的整数。")
    identity_text = private_ask("已有私钥路径（隐藏输入，可留空）：").strip()
    identity = None
    if identity_text:
        identity = Path(identity_text).expanduser()
        if not identity.is_absolute():
            raise SetupError("私钥路径需为绝对路径，或以~/开头。")
        require_outside(identity, project_root)
        if not identity.is_file():
            raise SetupError("指定私钥文件不存在。脚本不会生成或上传密钥。")
        quote_path(identity)

    lines = ["Host " + alias, "    HostName " + hostname, "    User " + username, "    Port " + str(int(port_text))]
    if identity is not None:
        lines.extend(["    IdentityFile " + quote_path(identity), "    IdentitiesOnly yes"])
    content = ("\n".join(lines) + "\n").encode("utf-8")
    include_line = ("Include " + quote_path(target) + "\n").encode("utf-8")
    print("将新增项目外的独立SSH配置，并在SSH主配置开头加入Include；原有配置正文逐字保留。")
    print("已有Include文件中的同名或通配规则仍可能影响SSH行为，请选一个未使用的别名。")
    if ask("确认写入？输入yes继续，其他输入取消：").strip().lower() != "yes":
        print("已取消，没有写入配置。")
        return False

    created = False
    committed = False
    target_identity = None
    temporary = None
    try:
        ssh_directory.mkdir(mode=0o700, exist_ok=True)
        include_directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(ssh_directory, 0o700)
        os.chmod(include_directory, 0o700)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as stream:
            target_identity = os.fstat(stream.fileno()).st_ino
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".eating-ssh-", dir=ssh_directory, delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(include_line + (original or b""))
            stream.flush()
            os.fsync(stream.fileno())
        if existing_bytes(main_config) != original:
            raise SetupError("SSH主配置在填写期间被修改，已停止，未覆盖该修改。")
        os.replace(temporary, main_config)
        committed = True
        temporary = None
    finally:
        if temporary is not None and temporary.resolve().parent == ssh_directory.resolve():
            temporary.unlink(missing_ok=True)
        if created and not committed and target.resolve() == include_directory.resolve() / target.name:
            if not target.is_symlink() and target.stat().st_ino == target_identity:
                target.unlink()
    print("配置完成。测试连接时运行：ssh " + alias)
    print("本脚本没有建立网络连接；首次连接请核对服务器主机指纹，登录密码只在SSH提示时输入。")
    return True


def main():
    if not sys.stdin.isatty():
        print("请在本机交互式终端运行，脚本不接收管道中的服务器信息。", file=sys.stderr)
        return 1
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            setup()
        return 0
    except getpass.GetPassWarning:
        print("终端不支持隐藏输入，已停止；请在本机终端直接运行。", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。")
        return 1
    except SetupError as error:
        print("配置未完成：" + str(error), file=sys.stderr)
        return 1
    except OSError:
        print("配置未完成：本机文件操作失败。为保护连接信息，未输出原始错误路径。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
