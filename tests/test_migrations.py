import sqlite3
import unittest
from pathlib import Path


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


if __name__ == '__main__':
    unittest.main()
