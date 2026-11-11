#!/usr/bin/env python3
"""Acquire, inspect, import, query and export pinned Bgee expression-call gzip TSV files."""
import argparse
import csv
import json
import sqlite3
import sys
from bgee_bulk_source import acquire, manifest
from bgee_bulk_store import export, ingest, inspect, query


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    fetch = commands.add_parser('fetch')
    fetch.add_argument('manifest')
    fetch.add_argument('output')
    fetch.add_argument('--max-bytes', type=int, default=128 * 1024**2)
    preview = commands.add_parser('inspect')
    preview.add_argument('source')
    load = commands.add_parser('import')
    load.add_argument('manifest')
    load.add_argument('source')
    load.add_argument('output')
    load.add_argument('--sha256', required=True)
    load.add_argument('--declared-genome-annotation')
    load.add_argument('--max-bytes', type=int, default=128 * 1024**2)
    load.add_argument('--max-uncompressed-bytes', type=int, default=8 * 1024**3)
    load.add_argument('--max-record-bytes', type=int, default=4 * 1024**2)
    load.add_argument('--max-rows', type=int, default=10_000_000)
    find = commands.add_parser('query')
    find.add_argument('database')
    for key in ['gene', 'anatomy', 'expression', 'quality', 'stage', 'sex', 'strain']:
        find.add_argument('--' + key)
    find.add_argument('--limit', type=int, default=100)
    find.add_argument('--offset', type=int, default=0)
    write = commands.add_parser('export')
    write.add_argument('database')
    write.add_argument('output')
    args = parser.parse_args()
    if args.command == 'fetch':
        result = acquire(manifest(args.manifest), args.output, args.max_bytes)
    elif args.command == 'inspect':
        result = inspect(args.source)
    elif args.command == 'import':
        result = ingest(args.source, manifest(args.manifest), args.sha256, args.output, max_bytes=args.max_bytes,
                        max_uncompressed_bytes=args.max_uncompressed_bytes, max_record_bytes=args.max_record_bytes,
                        max_rows=args.max_rows, declared_genome_annotation=args.declared_genome_annotation)
    elif args.command == 'query':
        result = query(args.database, **{key: value for key, value in vars(args).items() if key not in ('command', 'database')})
    else:
        result = export(args.database, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, EOFError, csv.Error, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
