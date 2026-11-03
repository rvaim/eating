import contextlib
import importlib.util
import io
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
specification = importlib.util.spec_from_file_location("ssh_key_import", scripts / "导入SSH私钥.py")
module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(module)


@unittest.skipUnless(shutil.which("ssh-keygen"), "OpenSSH key generation is required for temporary fixtures")
class SshKeyImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="eating-key-import-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / "home"
        self.project = self.root / "project"
        self.project.mkdir()
        self.ssh = self.home / ".ssh"
        self.include = self.ssh / "config.d"
        self.include.mkdir(parents=True)
        self.alias = "example-alias"
        self.config = self.include / "eating-example-alias.conf"
        self.original = b"Host example-alias\n    HostName example.invalid\n    User exampleuser\n    Port 2222\n    IdentityFile /example-only/old-key\n    IdentitiesOnly no\n"
        self.config.write_bytes(self.original)
        self.main = self.ssh / "config"
        self.main.write_text('Include "' + str(self.config) + '"\nHost other-example\n    HostName other.example.invalid\n')
        self.key = self.root / "downloaded example.pem"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "TEMPORARY-FIXTURE-ONLY", "-f", str(self.key)], check=True, capture_output=True)
        self.destination = self.ssh / "eating-example-alias.pem"

    def execute(self, path=None, confirmation="yes"):
        answers = iter([self.alias, confirmation])
        private = str(self.key) if path is None else path
        with contextlib.redirect_stdout(io.StringIO()) as output:
            result = module.import_key(self.home, self.project, lambda prompt: next(answers), lambda prompt: private)
        return result, output.getvalue()

    def test_copies_and_edits_only_alias_with_private_backup_and_no_output_leak(self):
        main = self.main.read_bytes()
        source = self.key.read_bytes()
        result, output = self.execute()
        self.assertTrue(result)
        self.assertEqual(self.key.read_bytes(), source)
        self.assertEqual(self.destination.read_bytes(), source)
        self.assertEqual(self.main.read_bytes(), main)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.ssh.stat().st_mode), 0o700)
        updated = self.config.read_text()
        self.assertIn('IdentityFile "' + str(self.destination) + '"', updated)
        for original in ["HostName example.invalid", "User exampleuser", "Port 2222"]:
            self.assertIn(original, updated)
        self.assertNotIn("old-key", updated)
        self.assertEqual(updated.count("IdentityFile"), 1)
        self.assertIn("IdentitiesOnly yes", updated)
        backups = list(self.include.glob(".eating-before-key-*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(list(self.project.iterdir()), [])
        for value in [str(self.key), str(self.destination), "example.invalid", "exampleuser", source.decode()]:
            self.assertNotIn(value, output)

    @unittest.skipUnless(shutil.which("ssh"), "OpenSSH parser is required")
    def test_openssh_uses_the_new_identity_without_network(self):
        self.execute(path=shlex.quote(str(self.key)))
        parsed = subprocess.run(["ssh", "-G", "-F", str(self.main), self.alias], check=True, capture_output=True, text=True)
        lines = parsed.stdout.splitlines()
        self.assertIn("identityfile " + str(self.destination), lines)
        self.assertIn("identitiesonly yes", lines)
        self.assertIn("port 2222", lines)

    def test_cancel_preserves_everything(self):
        result, output = self.execute(confirmation="no")
        self.assertFalse(result)
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(list(self.include.glob(".eating-before-key-*")))

    def test_repeated_import_reuses_identical_key_without_replacing_it(self):
        self.execute()
        inode = self.destination.stat().st_ino
        self.execute()
        self.assertEqual(self.destination.stat().st_ino, inode)
        self.assertEqual(self.config.read_text().count("IdentityFile"), 1)

    def test_different_existing_key_is_not_overwritten(self):
        self.destination.write_bytes(b"DIFFERENT-FIXTURE")
        with self.assertRaises(module.SetupError):
            self.execute()
        self.assertEqual(self.destination.read_bytes(), b"DIFFERENT-FIXTURE")
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_public_key_and_project_key_are_rejected(self):
        for path in [Path(str(self.key) + ".pub"), self.project / "example-key.pem"]:
            if path.parent == self.project:
                shutil.copyfile(self.key, path)
            with self.subTest(path=path.name):
                with self.assertRaises(module.SetupError):
                    self.execute(path=str(path))
                self.assertFalse(self.destination.exists())
                self.assertEqual(self.config.read_bytes(), self.original)

    def test_supports_main_host_block_and_preserves_other_hosts(self):
        self.config.unlink()
        suffix = b"Host other-example\r\n    HostName other.example.invalid\r\n    IdentityFile /example-only/other-key\r\n"
        self.main.write_bytes(b"Host=example-alias\r\n    HostName example.invalid\r\n    IdentityFile=/example-only/old-key\r\n    IdentitiesOnly = no\r\n" + suffix)
        self.execute()
        updated = self.main.read_bytes()
        self.assertTrue(updated.endswith(suffix))
        self.assertNotIn(b"old-key", updated)
        self.assertIn(b"IdentitiesOnly yes\r\n", updated)

    def test_shared_host_block_and_ambiguous_alias_are_rejected(self):
        self.config.write_text("Host example-alias other-example\n    HostName example.invalid\n")
        with self.assertRaises(module.SetupError):
            self.execute()
        self.config.write_bytes(self.original)
        self.main.write_text("Host example-alias\n    HostName duplicate.example.invalid\n")
        with self.assertRaises(module.SetupError):
            self.execute()
        self.assertFalse(self.destination.exists())

    def test_atomic_replace_failure_preserves_config_and_removes_only_new_key(self):
        with patch.object(module.os, "replace", side_effect=OSError("fixture failure")):
            with self.assertRaises(OSError):
                self.execute()
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertFalse(self.destination.exists())
        self.assertFalse(list(self.include.glob(".eating-key-config-*")))
        self.assertEqual(len(list(self.include.glob(".eating-before-key-*.bak"))), 1)

    def test_config_concurrent_change_is_preserved(self):
        answers = iter([self.alias, "yes"])
        def answer(prompt):
            value = next(answers)
            if value == "yes":
                self.config.write_text("# independently changed\n")
            return value
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(module.SetupError):
                module.import_key(self.home, self.project, answer, lambda prompt: str(self.key))
        self.assertEqual(self.config.read_text(), "# independently changed\n")
        self.assertFalse(self.destination.exists())

    def test_symlink_configuration_or_destination_is_rejected(self):
        original = self.root / "original-config"
        self.config.replace(original)
        self.config.symlink_to(original)
        with self.assertRaises(module.SetupError):
            self.execute()
        self.assertEqual(original.read_bytes(), self.original)
        self.config.unlink()
        self.config.write_bytes(self.original)
        self.destination.symlink_to(self.key)
        with self.assertRaises(module.SetupError):
            self.execute()

    def test_unreferenced_or_conditionally_included_config_is_not_modified(self):
        for content in ["# no include\n", 'Host other-example\n    Include "' + str(self.config) + '"\n']:
            with self.subTest(content=content):
                self.main.write_text(content)
                with self.assertRaises(module.SetupError):
                    self.execute()
                self.assertEqual(self.config.read_bytes(), self.original)
                self.assertFalse(self.destination.exists())

    def test_cli_rejects_pipeline(self):
        result = subprocess.run([sys.executable, "-B", str(scripts / "导入SSH私钥.py")], input="example-alias\n", capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("交互终端", result.stderr)


if __name__ == "__main__":
    unittest.main()
