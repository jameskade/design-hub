#!/usr/bin/env python3
"""只读存储清理报告；不删除数据库记录或文件。"""
import json
from pathlib import Path

import app


def size(path):
    try:
        return Path(path).stat().st_size
    except OSError:
        return 0


def main():
    totals = {"current_bytes": 0, "history_bytes": 0, "deleted_bytes": 0, "missing_files": 0}
    with app.db_connection() as db:
        versions = db.execute(
            """SELECT version.id,version.metadata_path,version.preview_path,artboard.current_version_id,artboard.deleted_at
               FROM artboard_versions version JOIN artboards artboard ON artboard.id=version.artboard_id"""
        ).fetchall()
        for version in versions:
            files = [version["metadata_path"], version["preview_path"], *[row[0] for row in db.execute("SELECT file_path FROM assets WHERE version_id=?", (version["id"],))]]
            amount = sum(size(path) for path in files)
            totals["missing_files"] += sum(not Path(path).is_file() for path in files)
            key = "deleted_bytes" if version["deleted_at"] else ("current_bytes" if version["id"] == version["current_version_id"] else "history_bytes")
            totals[key] += amount
        totals["source_packages"] = db.execute("SELECT count(*) FROM source_packages").fetchone()[0]
        totals["source_blobs"] = db.execute("SELECT count(*) FROM source_blobs").fetchone()[0]
        totals["source_stored_bytes"] = db.execute("SELECT coalesce(sum(stored_size),0) FROM source_blobs").fetchone()[0]
        totals["unreferenced_packages"] = db.execute(
            "SELECT count(*) FROM source_packages package WHERE NOT EXISTS(SELECT 1 FROM artboard_versions version WHERE version.source_package_id=package.id)"
        ).fetchone()[0]
    totals["history_reclaimable_bytes"] = totals["history_bytes"]
    print(json.dumps(totals, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
