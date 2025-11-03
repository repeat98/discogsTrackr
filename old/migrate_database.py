#!/usr/bin/env python3
"""
Database migration script to add new columns to the releases table.
Run this once to upgrade your existing database.
"""

import sqlite3
import os

DB_FILE = 'discogs_cache.db'

def migrate_database():
    """Add new columns to releases table if they don't exist."""
    
    if not os.path.exists(DB_FILE):
        print(f"Database {DB_FILE} does not exist. No migration needed.")
        return
    
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    # Get current columns
    cursor.execute("PRAGMA table_info(releases)")
    columns = {row[1] for row in cursor.fetchall()}
    
    print(f"Current columns: {columns}")
    
    # Define new columns to add
    new_columns = {
        'artist': 'TEXT',
        'title': 'TEXT',
        'label': 'TEXT',
        'year': 'INTEGER',
        'genres': 'TEXT',
        'styles': 'TEXT',
        'price': 'REAL',
        'have_count': 'INTEGER',
        'want_count': 'INTEGER',
        'youtube_video_id': 'TEXT',
        'video_urls': 'TEXT'
    }
    
    # Add missing columns
    added_count = 0
    for col_name, col_type in new_columns.items():
        if col_name not in columns:
            print(f"Adding column: {col_name} ({col_type})")
            cursor.execute(f'ALTER TABLE releases ADD COLUMN {col_name} {col_type}')
            added_count += 1
    
    conn.commit()
    conn.close()
    
    if added_count > 0:
        print(f"\n✅ Migration complete! Added {added_count} new columns.")
    else:
        print("\n✅ Database is already up to date!")

if __name__ == '__main__':
    print("Starting database migration...")
    migrate_database()

