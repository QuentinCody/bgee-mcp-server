import copy
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import bgee_bulk_store as store
from bgee_bulk_source import acquire, expression_links, manifest, NoRedirect, publish, sha256, validate_manifest


class Response(io.BytesIO):
    def __init__(self, raw, headers, status=200):
        super().__init__(raw)
        self.headers, self.status = headers, status


class BulkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.headers = store.REQUIRED + ['Developmental stage ID', 'Developmental stage name', 'Sex', 'Strain',
            'Including observed data', 'Self observation count', 'Descendant observation count', 'RNA-Seq expression', 'RNA-Seq FDR', 'future', 'future']
        self.rows = [
            ['GENE1', 'name', 'UBERON:1', 'tissue', 'present', 'gold quality', '1e-08', '01.00', '9e1', 'stage:1', 'adult', 'female', 'wild-type', 'yes', '1', '2', 'present', '0.00001', 'λ\nline', 'quote"tab\tvalue'],
            ['GENE1', 'name', 'UBERON:1', 'tissue', 'absent', 'silver quality', '0.1', '0', '1000', 'stage:2', 'larva', 'male', 'wild-type', 'yes', '1', '0', 'no data', 'NA', '', ''],
        ]
        self.rows.append(list(self.rows[0]))
        self.source = self.root / 'source.tsv.gz'
        self.output = self.root / 'snapshot.sqlite'
        self.write_source(self.headers, self.rows)

    def write_source(self, headers, rows, *, detail='advanced', scope='all_conditions'):
        buffer = io.StringIO(newline='')
        writer = csv.writer(buffer, delimiter='\t', lineterminator='\r\n')
        writer.writerow(headers)
        writer.writerows(rows)
        self.decoded = ('\ufeff' + buffer.getvalue()).encode()
        self.source.write_bytes(gzip.compress(self.decoded, mtime=0))
        name = 'Esox_lucius_expr_' + detail + ('_all_conditions' if scope == 'all_conditions' else '') + '.tsv.gz'
        url = 'https://www.bgee.org/ftp/current/download/calls/expr_calls/' + name
        html = '<html><h1>Species</h1><a href="' + url + '">wrong display label</a></html>'
        self.info = {'format_version': 'bgee-bulk-manifest-1', 'source': {'url': 'https://www.bgee.org/species/8010', 'requested_species_id': 8010,
            'html': html, 'html_sha256': hashlib.sha256(html.encode()).hexdigest(), 'response_sha256': hashlib.sha256(html.encode()).hexdigest(),
            'retrieved_at': 'synthetic', 'observed_release': None, 'genome_annotation': None},
            'artifact': {'url': url, 'filename': name, 'condition_scope': scope, 'detail': detail, 'bytes': self.source.stat().st_size, 'compression': 'gzip', 'etag': '"synthetic"'}}
        return self.info

    def import_source(self, **kwargs):
        return store.ingest(self.source, self.info, sha256(self.source), self.output, **kwargs)

    def test_preserves_all_cells_bytes_occurrences_and_unknown_columns(self):
        provenance = self.import_source()
        with sqlite3.connect(self.output) as database:
            values = database.execute('SELECT cells_json FROM source_records ORDER BY record_number').fetchall()
        self.assertEqual([json.loads(row[0]) for row in values], [self.headers] + self.rows)
        self.assertEqual(provenance['records'], 3)
        self.assertIsNone(provenance['manifest']['source']['observed_release'])
        output = self.root / 'exact.tsv'
        store.export(self.output, output)
        self.assertEqual(output.read_bytes(), self.decoded)
        result = store.query(self.output, gene='GENE1')
        self.assertEqual([row['record_number'] for row in result['rows']], [1, 2, 3])
        self.assertEqual(result['excluded_by_explicit_filters'], 0)
        self.assertEqual(result['rows'][0]['cells'][6:9], ['1e-08', '01.00', '9e1'])

    def test_conditions_quality_and_absence_are_explicit(self):
        self.import_source()
        result = store.query(self.output, gene='GENE1', stage='stage:1', sex='female', strain='wild-type', quality='gold quality', expression='present')
        self.assertEqual((result['base_matches'], result['filtered_matches'], result['excluded_by_explicit_filters']), (3, 2, 1))
        self.assertEqual([row['record_number'] for row in result['rows']], [1, 3])
        absent = store.query(self.output, anatomy='UBERON:1', expression='absent')
        self.assertEqual(absent['rows'][0]['cells'][16:18], ['no data', 'NA'])
        self.assertEqual(store.query(self.output, gene='MISSING')['rows'], [])

    def test_pagination_keeps_duplicate_occurrences(self):
        self.import_source()
        first = store.query(self.output, gene='GENE1', quality='gold quality', limit=1)
        second = store.query(self.output, gene='GENE1', quality='gold quality', limit=1, offset=first['next_offset'])
        self.assertEqual([first['rows'][0]['record_number'], second['rows'][0]['record_number']], [1, 3])
        self.assertIsNone(second['next_offset'])

    def test_anatomy_simple_does_not_invent_condition_values(self):
        self.write_source(store.REQUIRED, [row[:9] for row in self.rows], detail='simple', scope='anatomy')
        p = self.import_source()
        self.assertIsNone(p['mapping']['stage'])
        with self.assertRaisesRegex(ValueError, 'not represented'):
            store.query(self.output, gene='GENE1', stage='stage:1')
        self.assertEqual(len(store.query(self.output, gene='GENE1')['rows']), 3)

    def test_header_schema_drift_and_scope_mismatch_fail_atomically(self):
        for headers in [self.headers[1:], self.headers + ['FDR'], ['wrong']]:
            with self.subTest(headers=headers[:2]):
                self.write_source(headers, [])
                with self.assertRaisesRegex(ValueError, 'headers'):
                    self.import_source()
                self.assertFalse(self.output.exists())
        self.write_source(self.headers, self.rows, scope='anatomy')
        with self.assertRaisesRegex(ValueError, 'disagrees'):
            self.import_source()

    def test_corrupt_truncated_and_trailing_gzip_fail_atomically(self):
        good = self.source.read_bytes()
        for raw in [good[:-4], good[:-8] + b'badcrc!!', good + b'trailing junk']:
            self.source.write_bytes(raw)
            self.info['artifact']['bytes'] = len(raw)
            with self.assertRaises((OSError, EOFError, ValueError)):
                self.import_source()
            self.assertFalse(self.output.exists())
            self.assertEqual(list(self.root.glob('.bgee-bulk-*')), [])

    def test_malformed_utf8_tsv_and_width_fail_without_partial_output(self):
        header = '\t'.join(self.headers).encode() + b'\n'
        for raw in [header + b'\xff\n', header + b'"unterminated\n', header + b'few\tcolumns\n', b'']:
            self.source.write_bytes(gzip.compress(raw, mtime=0))
            self.info['artifact']['bytes'] = self.source.stat().st_size
            with self.assertRaises((ValueError, csv.Error)):
                self.import_source()
            self.assertFalse(self.output.exists())

    def test_hash_size_and_decompression_budgets(self):
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            store.ingest(self.source, self.info, '0' * 64, self.output)
        for kwargs in [{'max_bytes': 1}, {'max_uncompressed_bytes': 1}, {'max_record_bytes': 1}, {'max_rows': 1}]:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises((ValueError, csv.Error)):
                    self.import_source(**kwargs)
                self.assertFalse(self.output.exists())

    def test_exclusive_output_and_publication_race(self):
        self.output.write_bytes(b'existing')
        with self.assertRaises(FileExistsError):
            self.import_source()
        self.assertEqual(self.output.read_bytes(), b'existing')
        self.output.unlink()
        def race(temp, output):
            Path(output).write_bytes(b'race winner')
            publish(temp, output)
        with patch('bgee_bulk_store.publish', race), self.assertRaises(FileExistsError):
            self.import_source()
        self.assertEqual(self.output.read_bytes(), b'race winner')
        self.assertEqual(list(self.root.glob('.bgee-bulk-*')), [])

    def test_detects_source_replacement_before_publication(self):
        original = store.records
        def changed(*args):
            yield from original(*args)
            self.source.write_bytes(b'changed')
        with patch('bgee_bulk_store.records', changed), self.assertRaisesRegex(ValueError, 'byte size'):
            self.import_source()
        self.assertFalse(self.output.exists())

    def test_export_verifies_stored_bytes(self):
        self.import_source()
        with sqlite3.connect(self.output) as database:
            database.execute("UPDATE source_records SET raw_record=x'61' WHERE record_number=1")
        output = self.root / 'bad.tsv'
        with self.assertRaisesRegex(ValueError, 'no longer match'):
            store.export(self.output, output)
        self.assertFalse(output.exists())

    def test_query_budget_produces_a_resumable_page(self):
        rows = [row[:-1] + ['x' * (2 * 1024**2)] for row in self.rows]
        self.write_source(self.headers, rows)
        self.import_source()
        result = store.query(self.output, gene='GENE1')
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['next_offset'], 1)

    def test_inspection_is_explicitly_partial(self):
        result = store.inspect(self.source, count=1)
        self.assertFalse(result['complete_file_validated'])
        self.assertEqual(len(result['records']), 1)

    def test_manifest_source_membership_and_unknown_release(self):
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(self.info))
        self.assertEqual(manifest(path), self.info)
        for change in ['hash', 'url', 'scope', 'release', 'etag', 'size']:
            info = copy.deepcopy(self.info)
            if change == 'hash': info['source']['html'] += 'changed'
            if change == 'url': info['artifact']['url'] = 'https://evil.invalid/file.gz'
            if change == 'scope': info['artifact']['condition_scope'] = 'anatomy'
            if change == 'release': info['source']['observed_release'] = '16.0'
            if change == 'etag': info['artifact']['etag'] = 'W/"weak"'
            if change == 'size': info['artifact']['bytes'] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_manifest(info)

    def test_links_ignore_script_comments_processed_products_and_bad_hosts(self):
        html = self.info['source']['html']
        url = self.info['artifact']['url']
        self.assertEqual(expression_links(html + html, self.info['source']['url']), [{key: self.info['artifact'][key] for key in ['url', 'filename', 'condition_scope', 'detail']}])
        for source in ['<script>' + html + '</script>', '<!--' + html + '-->', html.replace('www.bgee.org/ftp', 'evil.invalid/ftp'), html.replace(url, url + '?q=1'), html.replace('advanced_all_conditions.tsv.gz', 'RNA-Seq_read_counts_TPM.tar.gz')]:
            with self.assertRaises(ValueError):
                expression_links(source, self.info['source']['url'])

    def test_acquisition_uses_condition_and_preserves_exact_bytes(self):
        raw = self.source.read_bytes()
        seen = []
        def opener(request, timeout):
            seen.append(request)
            return Response(raw, {'ETag': '"synthetic"', 'Content-Length': str(len(raw))})
        output = self.root / 'fetched.gz'
        result = acquire(self.info, output, opener=opener)
        self.assertEqual(seen[0].get_header('If-match'), '"synthetic"')
        self.assertEqual(output.read_bytes(), raw)
        self.assertEqual(result['sha256'], sha256(self.source))

    def test_failed_acquisition_leaves_no_partial_download(self):
        raw = self.source.read_bytes()
        for body, headers, status in [(raw, {'ETag': '"changed"'}, 200), (raw, {'ETag': '"synthetic"', 'Content-Range': 'bytes 0-1/2'}, 200),
                                      (raw[:-1], {'ETag': '"synthetic"'}, 200), (raw + b'x', {'ETag': '"synthetic"'}, 200),
                                      (raw, {'ETag': '"synthetic"', 'Content-Encoding': 'gzip'}, 200), (raw, {}, 302)]:
            output = self.root / 'failed.gz'
            with self.assertRaises(ValueError):
                acquire(self.info, output, opener=lambda *args, **kwargs: Response(body, headers, status))
            self.assertFalse(output.exists())
            self.assertEqual(list(self.root.glob('.bgee-bulk-*')), [])
        with self.assertRaisesRegex(ValueError, 'redirected'):
            NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')


if __name__ == '__main__':
    unittest.main()
