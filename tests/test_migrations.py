import sqlite3
import tomllib
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class AccountMigrationTests(unittest.TestCase):
    def test_schema_and_case_insensitive_email_uniqueness(self):
        db = sqlite3.connect(':memory:')
        db.executescript(Path('migrations/0001_accounts.sql').read_text())
        db.execute('INSERT INTO users (id, full_name, email, password_hash) VALUES (?, ?, ?, ?)', ('1', 'Ada User', 'ada@example.com', 'hash'))
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute('INSERT INTO users (id, full_name, email, password_hash) VALUES (?, ?, ?, ?)', ('2', 'Ada Again', 'ADA@example.com', 'hash'))
        columns = {row[1] for row in db.execute('PRAGMA table_info(users)')}
        self.assertTrue({'id', 'full_name', 'email', 'password_hash', 'status', 'created_at'} <= columns)
        self.assertNotIn('confirm_password', columns)
        self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)


class WranglerConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.pages = tomllib.loads((PROJECT_ROOT / 'wrangler.toml').read_text())
        self.coordinator = tomllib.loads((PROJECT_ROOT / 'coordinator' / 'wrangler.toml').read_text())

    def test_pages_uses_the_separately_deployed_durable_object_worker(self):
        self.assertEqual(self.pages['name'], 'project')
        self.assertEqual(self.pages['pages_build_output_dir'], '.')
        self.assertNotIn('main', self.pages)
        self.assertNotIn('services', self.pages)
        self.assertNotIn('env', self.pages)
        binding = next(item for item in self.pages['durable_objects']['bindings'] if item['name'] == 'FAN_COORDINATOR')
        coordinator_binding = next(item for item in self.coordinator['durable_objects']['bindings'] if item['name'] == 'FAN_COORDINATOR')
        self.assertEqual(binding['script_name'], self.coordinator['name'])
        self.assertEqual(binding['class_name'], coordinator_binding['class_name'])
        self.assertEqual(binding['class_name'], 'FanControlCoordinator')

    def test_production_pages_presenter_id_matches_the_coordinator_worker(self):
        self.assertEqual(self.pages['vars']['PRESENTER_USER_ID'], self.coordinator['vars']['PRESENTER_USER_ID'])

    def test_coordinator_worker_exports_its_sqlite_durable_object_migration(self):
        self.assertEqual(self.coordinator['main'], 'worker.js')
        worker_path = PROJECT_ROOT / 'coordinator' / self.coordinator['main']
        self.assertIn('export class FanControlCoordinator', worker_path.read_text())
        migrations = self.coordinator['migrations']
        self.assertEqual(len(migrations), 1)
        self.assertEqual(migrations[0]['tag'], 'v1')
        self.assertEqual(migrations[0]['new_sqlite_classes'], ['FanControlCoordinator'])


if __name__ == '__main__':
    unittest.main()
