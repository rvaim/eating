import contextlib
import importlib.util
import io
from pathlib import Path
import stat
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


script_path = Path(__file__).resolve().parents[1] / "scripts" / "配置SSH别名.py"
specification = importlib.util.spec_from_file_location("ssh_alias_setup", script_path)
setup_module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(setup_module)


class SshAliasTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="eating-ssh-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / "home"
        self.project = self.root / "project"
        self.home.mkdir()
        self.project.mkdir()

    def run_setup(self, alias="example-alias", confirmation="yes", values=None):
        answers = iter([alias, confirmation])
        private = iter(values or ["203.0.113.10", "exampleuser", "22", ""])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = setup_module.setup(self.home, self.project, lambda prompt: next(answers), lambda prompt: next(private))
        return result, output.getvalue()

    def test_creates_external_config_preserves_existing_bytes_and_hides_values(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        original = b"# existing settings\nHost original-example\n    HostName original.example.invalid\n"
        main = ssh_directory / "config"
        main.write_bytes(original)
        result, output = self.run_setup()
        self.assertTrue(result)
        include = ssh_directory / "config.d" / "eating-example-alias.conf"
        self.assertEqual(include.read_text(), "Host example-alias\n    HostName 203.0.113.10\n    User exampleuser\n    Port 22\n")
        self.assertEqual(main.read_bytes().split(b"\n", 1)[1], original)
        self.assertTrue(main.read_text().startswith('Include "'))
        self.assertEqual(stat.S_IMODE(main.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(include.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(ssh_directory.stat().st_mode), 0o700)
        self.assertEqual(list(self.project.iterdir()), [])
        self.assertNotIn("203.0.113.10", output)
        self.assertNotIn("exampleuser", output)
        self.assertNotIn(str(self.home), output)

    @unittest.skipUnless(shutil.which("ssh"), "OpenSSH is required for parser validation")
    def test_generated_include_is_accepted_by_openssh_without_connecting(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        main = ssh_directory / "config"
        main.write_text("Host *\n    Port 2200\n")
        self.run_setup()
        parsed = subprocess.run(["ssh", "-G", "-F", str(main), "example-alias"], capture_output=True, text=True, check=True)
        settings = dict(line.split(" ", 1) for line in parsed.stdout.splitlines() if " " in line)
        self.assertEqual(settings["hostname"], "203.0.113.10")
        self.assertEqual(settings["user"], "exampleuser")
        self.assertEqual(settings["port"], "22")

    def test_non_interactive_cli_refuses_pipe_input(self):
        result = subprocess.run([sys.executable, "-B", str(script_path)], input="example-alias\n", capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("交互式终端", result.stderr)

    def test_cli_stops_if_hidden_input_is_unavailable(self):
        with patch.object(setup_module.sys.stdin, "isatty", return_value=True), patch.object(setup_module, "setup", side_effect=setup_module.getpass.GetPassWarning("fixture warning")):
            with contextlib.redirect_stderr(io.StringIO()) as output:
                result = setup_module.main()
        self.assertEqual(result, 1)
        self.assertIn("不支持隐藏输入", output.getvalue())

    def test_cancel_does_not_create_ssh_directory(self):
        result, output = self.run_setup(confirmation="no")
        self.assertFalse(result)
        self.assertFalse((self.home / ".ssh").exists())
        self.assertIn("没有写入", output)

    def test_refuses_duplicate_without_modifying_main(self):
        self.run_setup()
        main = self.home / ".ssh" / "config"
        original = main.read_bytes()
        with self.assertRaises(setup_module.SetupError):
            self.run_setup()
        self.assertEqual(main.read_bytes(), original)

    def test_refuses_alias_already_in_main_case_insensitively(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        main = ssh_directory / "config"
        original = b"Host EXAMPLE-ALIAS another-alias\n    HostName example.invalid\n"
        main.write_bytes(original)
        with self.assertRaises(setup_module.SetupError):
            self.run_setup()
        self.assertEqual(main.read_bytes(), original)

    def test_rejects_injection_and_invalid_fields_before_writing(self):
        scenarios = [
            ["example.invalid\nProxyCommand something", "exampleuser", "22", ""],
            ["https://example.invalid", "exampleuser", "22", ""],
            ["example.invalid", "exampleuser\nPort 1", "22", ""],
            ["example.invalid", "exampleuser", "70000", ""],
            ["example.invalid", "exampleuser", "１２", ""],
            ["example.invalid", "exampleuser", "22", "relative-key"],
        ]
        for values in scenarios:
            with self.subTest(values=values):
                with self.assertRaises(setup_module.SetupError):
                    self.run_setup(values=values)
                self.assertFalse((self.home / ".ssh").exists())
        for alias in ["-example", "example*", "example\nHost injected", "example alias"]:
            with self.subTest(alias=alias):
                with self.assertRaises(setup_module.SetupError):
                    self.run_setup(alias=alias)

    def test_rejects_project_destination_and_project_key(self):
        inside = self.project / "private-home"
        inside.mkdir()
        with self.assertRaises(setup_module.SetupError):
            setup_module.setup(inside, self.project)
        key = self.project / "example-key"
        key.write_text("EXAMPLE ONLY")
        with self.assertRaises(setup_module.SetupError):
            self.run_setup(values=["example.invalid", "exampleuser", "22", str(key)])
        self.assertFalse((self.home / ".ssh").exists())

    def test_existing_key_is_referenced_without_reading_content(self):
        key = self.home / "example key"
        key.write_text("EXAMPLE ONLY")
        original_read_bytes = Path.read_bytes
        original_read_text = Path.read_text
        def read_bytes(path):
            if path == key:
                raise AssertionError("Private key content must not be read")
            return original_read_bytes(path)
        def read_text(path, *args, **kwargs):
            if path == key:
                raise AssertionError("Private key content must not be read")
            return original_read_text(path, *args, **kwargs)
        with patch.object(Path, "read_bytes", read_bytes), patch.object(Path, "read_text", read_text):
            result, output = self.run_setup(values=["2001:db8::1", "exampleuser", "2222", str(key)])
        self.assertTrue(result)
        content = (self.home / ".ssh/config.d/eating-example-alias.conf").read_text()
        self.assertIn('IdentityFile "' + str(key) + '"', content)
        self.assertIn("IdentitiesOnly yes", content)
        self.assertNotIn(str(key), output)

    def test_refuses_symlink_main_and_preserves_target(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        target = self.root / "external-config"
        target.write_bytes(b"original")
        (ssh_directory / "config").symlink_to(target)
        with self.assertRaises(setup_module.SetupError):
            self.run_setup()
        self.assertEqual(target.read_bytes(), b"original")

    def test_failed_atomic_replace_preserves_original_and_removes_new_config(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        main = ssh_directory / "config"
        original = b"Host original-example\n    HostName example.invalid\n"
        main.write_bytes(original)
        with patch.object(setup_module.os, "replace", side_effect=OSError("fixture failure")):
            with self.assertRaises(OSError):
                self.run_setup()
        self.assertEqual(main.read_bytes(), original)
        self.assertEqual(list((ssh_directory / "config.d").iterdir()), [])
        self.assertFalse(list(ssh_directory.glob(".eating-ssh-*")))

    def test_rejects_concurrent_main_changes_without_overwriting_them(self):
        ssh_directory = self.home / ".ssh"
        ssh_directory.mkdir()
        main = ssh_directory / "config"
        main.write_text("# original\n")
        answers = iter(["example-alias", "yes"])
        private = iter(["example.invalid", "exampleuser", "22", ""])
        def answer(prompt):
            value = next(answers)
            if value == "yes":
                main.write_text("# independently updated\n")
            return value
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(setup_module.SetupError):
                setup_module.setup(self.home, self.project, answer, lambda prompt: next(private))
        self.assertEqual(main.read_text(), "# independently updated\n")
        self.assertFalse((ssh_directory / "config.d/eating-example-alias.conf").exists())


if __name__ == "__main__":
    unittest.main()
