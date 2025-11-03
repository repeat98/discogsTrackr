#!/usr/bin/env python3
"""
Script to fix stuck jobs and restart them.
"""

import sqlite3
import sys

def fix_stuck_jobs():
    """Mark stuck jobs as failed so they can be restarted."""
    conn = sqlite3.connect('discogs_cache.db')
    cursor = conn.cursor()
    
    # Find processing jobs
    cursor.execute('''
        SELECT job_id, seller_username, status, progress, total, current_step
        FROM jobs
        WHERE status IN ('pending', 'processing')
    ''')
    
    stuck_jobs = cursor.fetchall()
    
    if not stuck_jobs:
        print("No stuck jobs found.")
        return
    
    print(f"Found {len(stuck_jobs)} stuck job(s):")
    for job in stuck_jobs:
        print(f"  Job ID: {job[0]}")
        print(f"  Seller: {job[1]}")
        print(f"  Status: {job[2]}")
        print(f"  Progress: {job[3]}/{job[4]}")
        print(f"  Step: {job[5]}")
        print()
    
    response = input("Mark these jobs as 'error' so they can be restarted? (y/n): ")
    
    if response.lower() == 'y':
        cursor.execute('''
            UPDATE jobs
            SET status = 'error',
                error_message = 'Job was stuck and manually reset',
                updated_at = datetime('now')
            WHERE status IN ('pending', 'processing')
        ''')
        conn.commit()
        print(f"Marked {len(stuck_jobs)} job(s) as error. You can now search for the seller again.")
    else:
        print("No changes made.")
    
    conn.close()

if __name__ == '__main__':
    fix_stuck_jobs()

