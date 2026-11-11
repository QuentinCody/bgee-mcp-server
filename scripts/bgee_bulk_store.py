"""Retain all Bgee TSV occurrences, conditions, source cells and decoded bytes."""
from contextlib import contextmanager
import csv
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
from bgee_bulk_source import compact, publish, temporary, verify_file

LABELS = {'gene': 'Gene ID', 'anatomy': 'Anatomical entity ID', 'expression': 'Expression', 'quality': 'Call quality',
          'stage': 'Developmental stage ID', 'sex': 'Sex', 'strain': 'Strain'}
REQUIRED = ['Gene ID', 'Gene name', 'Anatomical entity ID', 'Anatomical entity name', 'Expression', 'Call quality', 'FDR', 'Expression score', 'Expression rank']


def records(path, max_bytes=8 * 1024**3, max_record_bytes=4 * 1024**2):
    previous_limit = csv.field_size_limit(max_record_bytes)
    try:
        with gzip.open(path, 'rb') as stream:
            raw_parts = []
            total, consumed, line_number = 0, 0, 0
            def lines():
                nonlocal total, consumed, line_number
                while raw := stream.readline(max_record_bytes + 1):
                    total += len(raw)
                    consumed += len(raw)
                    line_number += 1
                    if consumed > max_record_bytes or total > max_bytes:
                        raise ValueError('Decoded artifact exceeds record/total byte budget')
                    text = raw.decode('utf-8', errors='strict')
                    raw_parts.append(raw)
                    yield text.removeprefix('\ufeff') if line_number == 1 else text
            reader = csv.reader(lines(), delimiter='\t', quotechar='"', strict=True)
            for values in reader:
                yield values, b''.join(raw_parts)
                raw_parts.clear()
                consumed = 0
    finally:
        csv.field_size_limit(previous_limit)


def inspect(path, count=5):
    if type(count) is not int or not 1 <= count <= 20:
        raise ValueError('Preview count must be 1–20 records')
    result = []
    iterator = records(path)
    try:
        for number, (values, raw) in enumerate(iterator):
            result.append({'record_number': number, 'columns': len(values), 'bytes': len(raw), 'preview': raw.decode()[:4096], 'preview_truncated': len(raw.decode()) > 4096})
            if len(result) >= count:
                break
    finally:
        iterator.close()
    return {'records': result, 'complete_file_validated': False}


def layout(headers, artifact):
    required = list(REQUIRED)
    if artifact['condition_scope'] == 'all_conditions':
        required += ['Developmental stage ID', 'Developmental stage name', 'Sex', 'Strain']
    elif any(label in headers for label in ['Developmental stage ID', 'Developmental stage name', 'Sex', 'Strain']):
        raise ValueError('Anatomy-only filename disagrees with condition columns')
    if artifact['detail'] == 'advanced':
        required += ['Including observed data', 'Self observation count', 'Descendant observation count']
    if any(headers.count(label) != 1 for label in required):
        raise ValueError('Required native Bgee headers are missing or ambiguous; inspect this file schema')
    return {key: headers.index(label) if headers.count(label) == 1 else None for key, label in LABELS.items()}


def ingest(path, info, expected_sha256, output, *, max_bytes=128 * 1024**2, max_uncompressed_bytes=8 * 1024**3,
           max_record_bytes=4 * 1024**2, max_rows=10_000_000, declared_genome_annotation=None):
    if any(type(value) is not int or value <= 0 for value in (max_bytes, max_uncompressed_bytes, max_record_bytes, max_rows)):
        raise ValueError('Import budgets must be positive integers')
    source_hash = verify_file(path, info, expected_sha256, max_bytes)
    temp, database = temporary(output), None
    try:
        database = sqlite3.connect(temp)
        database.execute('PRAGMA journal_mode=DELETE')
        database.execute('CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL)')
        database.execute('CREATE TABLE source_records(record_number INTEGER PRIMARY KEY,gene TEXT,anatomy TEXT,expression TEXT,quality TEXT,stage TEXT,sex TEXT,strain TEXT,cells_json TEXT NOT NULL,raw_record BLOB NOT NULL)')
        headers = mapping = None
        count, decoded_bytes, digest = 0, 0, hashlib.sha256()
        with database:
            for number, (values, raw) in enumerate(records(path, max_uncompressed_bytes, max_record_bytes)):
                digest.update(raw)
                decoded_bytes += len(raw)
                if headers is None:
                    headers = values
                    mapping = layout(headers, info['artifact'])
                    indexed = [None] * len(LABELS)
                else:
                    count += 1
                    if count > max_rows or len(values) != len(headers):
                        raise ValueError('Record count/column width differs from the selected layout or budget')
                    indexed = [values[index] if index is not None else None for index in mapping.values()]
                    if not indexed[0] or not indexed[1] or any('\x00' in value for value in indexed if value is not None):
                        raise ValueError('Empty gene/anatomy or NUL-containing indexed value')
                database.execute('INSERT INTO source_records VALUES (?,?,?,?,?,?,?,?,?,?)', [number, *indexed, compact(values), raw])
            if headers is None:
                raise ValueError('Empty file cannot establish a Bgee header')
            verify_file(path, info, source_hash, max_bytes)
            provenance = {'format_version': 'bgee-bulk-sqlite-1', 'manifest': info, 'artifact_sha256': source_hash,
                          'decoded_sha256': digest.hexdigest(), 'decoded_bytes': decoded_bytes, 'records': count, 'columns': len(headers),
                          'headers': headers, 'mapping': mapping, 'declared_genome_annotation': declared_genome_annotation,
                          'scope': 'All selected-file records, string cells and original decoded bytes; no call filtering, numeric coercion, inferred release, correction status, deduplication or cross-species equivalence.'}
            database.execute("INSERT INTO metadata VALUES ('provenance',?)", (compact(provenance),))
            database.execute('CREATE INDEX by_gene ON source_records(gene,anatomy,record_number)')
            database.execute('CREATE INDEX by_anatomy ON source_records(anatomy,gene,record_number)')
        database.close()
        database = None
        publish(temp, output)
        return provenance
    finally:
        if database is not None:
            database.close()
        temp.unlink(missing_ok=True)
        Path(str(temp) + '-journal').unlink(missing_ok=True)


@contextmanager
def opened(path):
    database = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    try:
        row = database.execute("SELECT value FROM metadata WHERE name='provenance'").fetchone()
        provenance = json.loads(row[0]) if row else {}
        if provenance.get('format_version') != 'bgee-bulk-sqlite-1':
            raise ValueError('Not a Bgee bulk snapshot')
        yield database, provenance
    finally:
        database.close()


def query(path, *, gene=None, anatomy=None, expression=None, quality=None, stage=None, sex=None, strain=None, limit=100, offset=0):
    if not gene and not anatomy:
        raise ValueError('Supply a literal gene or anatomy identifier')
    if type(limit) is not int or not 1 <= limit <= 1000 or type(offset) is not int or offset < 0:
        raise ValueError('Use limit 1–1000 and nonnegative offset')
    selected = {key: value for key, value in dict(gene=gene, anatomy=anatomy, expression=expression, quality=quality, stage=stage, sex=sex, strain=strain).items() if value is not None}
    with opened(path) as (database, provenance):
        if any(provenance['mapping'][key] is None for key in selected):
            raise ValueError('A selected condition is not represented in this file scope')
        base = {key: value for key, value in selected.items() if key in ('gene', 'anatomy')}
        def predicate(filters):
            return ' AND '.join(key + '=?' for key in filters)
        base_count = database.execute('SELECT count(*) FROM source_records WHERE ' + predicate(base), list(base.values())).fetchone()[0]
        filtered_count = database.execute('SELECT count(*) FROM source_records WHERE ' + predicate(selected), list(selected.values())).fetchone()[0]
        cursor = database.execute('SELECT record_number,cells_json,raw_record FROM source_records WHERE ' + predicate(selected) + ' ORDER BY record_number LIMIT ? OFFSET ?', [*selected.values(), limit + 1, offset])
        result, size, more = [], 0, False
        for number, encoded, raw in cursor:
            item = {'record_number': number, 'cells': json.loads(encoded), 'raw_record': raw.decode(), 'raw_record_sha256': hashlib.sha256(raw).hexdigest()}
            size += len(compact(item).encode())
            if len(result) == limit or size > 8 * 1024**2:
                if not result:
                    raise ValueError('Record exceeds query output budget; inspect the local SQLite snapshot directly')
                more = True
                break
            result.append(item)
        return {'provenance': provenance, 'filters': selected, 'base_matches': base_count, 'filtered_matches': filtered_count,
                'excluded_by_explicit_filters': base_count - filtered_count, 'rows': result, 'next_offset': offset + len(result) if more else None,
                'scope': 'Exact literal matches in this file. Excluded or missing calls are not absent-expression evidence; score, FDR, call quality and observation support remain separate native cells.'}


def export(path, output):
    temp = temporary(output)
    try:
        digest, size = hashlib.sha256(), 0
        with opened(path) as (database, provenance), temp.open('wb') as target:
            for (raw,) in database.execute('SELECT raw_record FROM source_records ORDER BY record_number'):
                target.write(raw)
                digest.update(raw)
                size += len(raw)
        if digest.hexdigest() != provenance['decoded_sha256'] or size != provenance['decoded_bytes']:
            raise ValueError('Stored source records no longer match the imported snapshot')
        publish(temp, output)
        return {'path': str(output), 'sha256': digest.hexdigest(), 'bytes': size}
    finally:
        temp.unlink(missing_ok=True)
