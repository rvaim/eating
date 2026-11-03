#!/usr/bin/env python3
import fnmatch
import getpass
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import warnings

from 配置SSH别名 import SetupError, existing_bytes, quote_path, require_outside


def parse_line(line):
    try:
        tokens = shlex.split(line, comments=True)
        if tokens and "=" in tokens[0]:
            name, value = tokens[0].split("=", 1)
            tokens = [name] + ([value] if value else []) + tokens[1:]
        if len(tokens) > 1 and tokens[1] == "=":
            tokens = tokens[:1] + tokens[2:]
        return tokens
    except ValueError:
        raise SetupError("SSH配置包含无法安全解析的内容，未修改。")


def alias_blocks(content, alias):
    try:
        lines = content.decode("utf-8").splitlines(keepends=True)
    except UnicodeError:
        raise SetupError("SSH配置不是UTF-8文本，未修改。")
    starts = []
    for index, line in enumerate(lines):
        tokens = parse_line(line)
        if tokens and tokens[0].lower() in ("host", "match"):
            starts.append((index, tokens))
    matches = []
    for position, (index, tokens) in enumerate(starts):
        if tokens[0].lower() != "host" or alias.lower() not in [token.lower() for token in tokens[1:]]:
            continue
        if len(tokens) != 2:
            raise SetupError("该Host段同时服务多个别名，请先在项目外单独拆分，避免影响其他连接。")
        end = starts[position + 1][0] if position + 1 < len(starts) else len(lines)
        if any(parse_line(line)[:1] and parse_line(line)[0].lower() == "include" for line in lines[index + 1:end]):
            raise SetupError("该Host段内部还有Include，请先手动核对，脚本不改写其他配置。")
        matches.append((lines, index, end))
    return matches


def edit_identity(content, alias, destination):
    matches = alias_blocks(content, alias)
    if len(matches) != 1:
        raise SetupError("未找到唯一的单独Host段，未修改。")
    lines, start, end = matches[0]
    newline = "\r\n" if lines[start].endswith("\r\n") else "\n"
    header = lines[start] if lines[start].endswith("\n") else lines[start] + newline
    replacement = [header, "    IdentityFile " + quote_path(destination) + newline, "    IdentitiesOnly yes" + newline]
    for line in lines[start + 1:end]:
        tokens = parse_line(line)
        if tokens and tokens[0].lower().rstrip("=") in ("identityfile", "identitiesonly"):
            continue
        replacement.append(line)
    return "".join(lines[:start] + replacement + lines[end:]).encode("utf-8")


def input_path(value):
    value = value.strip()
    if any(character in value for character in "\r\n\x00"):
        raise SetupError("文件路径无效。")
    direct = Path(value).expanduser()
    if direct.is_absolute() and direct.is_file():
        return direct
    try:
        tokens = shlex.split(value)
    except ValueError:
        raise SetupError("文件路径格式无效；可将文件拖入终端后确认。")
    if len(tokens) != 1:
        raise SetupError("请填写一个完整文件路径。")
    return Path(tokens[0]).expanduser()


def find_config(ssh_directory, alias, project_root):
    candidates = [ssh_directory / "config", ssh_directory / "config.d" / ("eating-" + alias + ".conf")]
    matches = []
    for path in candidates:
        require_outside(path, project_root)
        data = existing_bytes(path)
        if data is not None and alias_blocks(data, alias):
            matches.append((path, data))
    if len(matches) != 1:
        raise SetupError("没有找到唯一的别名配置。请先配置别名；脚本只处理SSH主配置或原别名脚本创建的独立文件。")
    if matches[0][0] != candidates[0]:
        main = existing_bytes(candidates[0])
        if main is None:
            raise SetupError("独立别名配置尚未接入SSH主配置，请先运行别名配置脚本。")
        included = False
        try:
            for line in main.decode("utf-8").splitlines():
                tokens = parse_line(line)
                if not tokens:
                    continue
                if tokens[0].lower() in ("host", "match"):
                    break
                if tokens[0].lower() == "include":
                    for value in tokens[1:]:
                        pattern = Path(value).expanduser()
                        if not pattern.is_absolute():
                            pattern = ssh_directory / pattern
                        if fnmatch.fnmatch(str(matches[0][0]), str(pattern)):
                            included = True
        except UnicodeError:
            raise SetupError("SSH主配置不是UTF-8文本，未修改。")
        if not included:
            raise SetupError("未确认独立别名文件已在SSH主配置全局Include中，请先核对别名配置。")
    return matches[0]


def import_key(home=None, project_root=None, ask=input, private_ask=getpass.getpass):
    home = Path.home() if home is None else Path(home)
    project_root = Path(__file__).resolve().parent.parent if project_root is None else Path(project_root).resolve()
    ssh_directory = home / ".ssh"
    for directory in (ssh_directory, ssh_directory / "config.d"):
        require_outside(directory, project_root)
        if directory.is_symlink() or directory.exists() and not directory.is_dir():
            raise SetupError("SSH目录不是普通目录，未修改。")
    alias = ask("已有SSH别名：").strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", alias):
        raise SetupError("别名格式无效。")
    config_path, original = find_config(ssh_directory, alias, project_root)
    print("输入下载的PEM／OpenSSH私钥路径；输入隐藏，可粘贴或拖入文件。不要粘贴密钥正文。")
    source = input_path(private_ask("私钥文件完整路径（隐藏输入）："))
    if not source.is_absolute():
        raise SetupError("请使用绝对路径或~/开头的路径。")
    require_outside(source, project_root)
    if not source.is_file() or source.stat().st_size > 1024 * 1024:
        raise SetupError("私钥文件不存在或大小不适合导入。")
    destination = ssh_directory / ("eating-" + alias + ".pem")
    require_outside(destination, project_root)
    if destination.is_symlink():
        raise SetupError("密钥目标是符号链接，未修改。")
    key = source.read_bytes()
    first = re.match(rb"\s*-----BEGIN (OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----", key)
    if first is None or b"-----END " + first.group(1) + b"-----" not in key:
        raise SetupError("文件没有匹配的私钥头尾；请确认选择的是私钥文件，不是公钥或证书。")
    if destination.exists() and (not destination.is_file() or destination.read_bytes() != key):
        raise SetupError("目标位置已有不同密钥，脚本不会覆盖。请先在项目外自行核对。")
    updated = edit_identity(original, alias, destination)
    print("将保留下载原文件，把私钥复制到项目外的SSH目录，设为600，并仅更新该别名的IdentityFile／IdentitiesOnly。")
    print("原别名配置会先在同一项目外目录保存一份600权限备份；不会连接服务器或上传密钥。")
    if ask("确认执行？输入yes继续：").strip().lower() != "yes":
        print("已取消，没有复制或修改。")
        return False

    created_key = False
    key_inode = None
    temporary = None
    committed = False
    try:
        if existing_bytes(config_path) != original:
            raise SetupError("别名配置在填写期间被修改，已停止。")
        if not destination.exists():
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created_key = True
            with os.fdopen(descriptor, "wb") as stream:
                key_inode = os.fstat(stream.fileno()).st_ino
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
        else:
            os.chmod(destination, 0o600)
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".eating-before-key-", suffix=".bak", dir=config_path.parent, delete=False) as stream:
            os.chmod(stream.name, 0o600)
            stream.write(original)
            stream.flush()
            os.fsync(stream.fileno())
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".eating-key-config-", dir=config_path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            os.chmod(temporary, 0o600)
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        if existing_bytes(config_path) != original:
            raise SetupError("别名配置在操作期间被修改，已停止并保留该修改。")
        os.replace(temporary, config_path)
        temporary = None
        committed = True
        os.chmod(ssh_directory, 0o700)
    finally:
        if temporary is not None and temporary.resolve().parent == config_path.parent.resolve():
            temporary.unlink(missing_ok=True)
        if created_key and not committed and destination.resolve() == ssh_directory.resolve() / destination.name:
            if not destination.is_symlink() and destination.stat().st_ino == key_inode:
                destination.unlink()
    print("复制和别名编辑完成，原文件保持不动。")
    print("请在本机终端测试：ssh -o BatchMode=yes " + alias + " 'true'")
    print("若密钥有口令，先用ssh-add在本机加载导入后的密钥；本脚本不保存口令，也不保证该密钥已被服务器授权。")
    return True


def main():
    if not sys.stdin.isatty():
        print("请在本机交互终端直接运行，不要通过管道传入私钥路径。", file=sys.stderr)
        return 1
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            import_key()
        return 0
    except getpass.GetPassWarning:
        print("终端无法隐藏输入，已停止。", file=sys.stderr)
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。")
    except SetupError as error:
        print("未完成：" + str(error), file=sys.stderr)
    except OSError:
        print("未完成：本机文件操作失败；为保护信息，不显示真实路径。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
