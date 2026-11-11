"""Validate MCP-discovered Bgee links and acquire one exact conditional gzip artifact."""
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import urljoin, urlsplit
import urllib.request


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def expression_links(html, source_url):
    found = {}
    pattern = re.compile(r'^([A-Za-z][A-Za-z0-9_-]*)_expr_(simple|advanced)(_all_conditions)?\.tsv\.gz$')
    class Links(HTMLParser):
        ignored = 0
        def handle_starttag(self, tag, attrs):
            if tag in ('script', 'style'):
                self.ignored += 1
            if tag != 'a' or self.ignored:
                return
            href = dict(attrs).get('href') or ''
            if re.search(r'[%\\\s]', href):
                return
            try:
                url = urljoin(source_url, href)
                parts = urlsplit(url)
                if parts.scheme != 'https' or parts.hostname not in ('www.bgee.org', 'bgee.org') or parts.username or parts.password or parts.port or parts.query or parts.fragment or not parts.path.startswith('/ftp/'):
                    return
            except ValueError:
                return
            filename = parts.path.rsplit('/', 1)[-1]
            match = pattern.fullmatch(filename)
            if match:
                found[url] = {'url': url, 'filename': filename, 'condition_scope': 'all_conditions' if match[3] else 'anatomy', 'detail': match[2]}
        def handle_endtag(self, tag):
            if tag in ('script', 'style'):
                self.ignored = max(0, self.ignored - 1)
    parser = Links(convert_charrefs=True)
    parser.feed(html)
    parser.close()
    if not 1 <= len(found) <= 16 or len({pattern.fullmatch(item['filename'])[1] for item in found.values()}) != 1:
        raise ValueError('Species page has no unambiguous bounded expression-call download links')
    return [found[url] for url in sorted(found)]


def manifest(path):
    return validate_manifest(json.loads(Path(path).read_text(encoding='utf-8')))


def validate_manifest(info):
    if not isinstance(info, dict) or info.get('format_version') != 'bgee-bulk-manifest-1':
        raise ValueError('Expected complete bgee-bulk-manifest-1 data object')
    source, artifact = info['source'], info['artifact']
    species = source['requested_species_id']
    if type(species) is not int or species <= 0 or source['url'] != 'https://www.bgee.org/species/' + str(species):
        raise ValueError('Unexpected species-page identity')
    if not isinstance(source['html'], str) or len(source['html'].encode()) > 2 * 1024**2 or hashlib.sha256(source['html'].encode()).hexdigest() != source['html_sha256']:
        raise ValueError('Species-page HTML differs from its pinned hash')
    links = expression_links(source['html'], source['url'])
    identity = {'source_url': source['url'], 'requested_species_id': species, 'artifacts': links}
    if source.get('artifacts_sha256') is not None and hashlib.sha256(compact(identity).encode()).hexdigest() != source['artifacts_sha256']:
        raise ValueError('Artifact projection differs from its pinned hash')
    selected = next((row for row in links if row['url'] == artifact['url']), None)
    if not selected or any(artifact.get(key) != value for key, value in selected.items()):
        raise ValueError('Artifact identity differs from the source page')
    if type(artifact['bytes']) is not int or artifact['bytes'] <= 0 or artifact.get('compression') != 'gzip':
        raise ValueError('Artifact requires positive exact gzip byte size')
    if not isinstance(artifact.get('etag'), str) or not re.fullmatch(r'"[^"\r\n]+"', artifact['etag']):
        raise ValueError('Artifact requires a strong ETag')
    if source.get('observed_release') is not None or source.get('genome_annotation') is not None:
        raise ValueError('Discovery does not establish release or genome annotation; retain these as unknown')
    return info


def verify_file(path, info, expected_sha256, max_bytes):
    validate_manifest(info)
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected_sha256):
        raise ValueError('Supply the exact acquired SHA-256')
    size = Path(path).stat().st_size
    if size != info['artifact']['bytes'] or size > max_bytes:
        raise ValueError('Source differs from the declared byte size or exceeds the budget')
    actual = sha256(path)
    if actual != expected_sha256.lower():
        raise ValueError('Source SHA-256 differs from the selected pin')
    return actual


def temporary(output):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise FileExistsError('Output already exists; select a new path')
    handle, name = tempfile.mkstemp(prefix='.bgee-bulk-', dir=output.parent)
    os.close(handle)
    return Path(name)


def publish(temp, output):
    os.link(temp, output)
    temp.unlink()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Bgee artifact redirected; select a new provider manifest')


def acquire(info, output, max_bytes=128 * 1024**2, opener=None):
    validate_manifest(info)
    artifact = info['artifact']
    if artifact['bytes'] > max_bytes:
        raise ValueError('Artifact exceeds download budget')
    temp = temporary(output)
    opener = opener or urllib.request.build_opener(NoRedirect()).open
    started, size, digest = time.monotonic(), 0, hashlib.sha256()
    try:
        request = urllib.request.Request(artifact['url'], headers={'Accept-Encoding': 'identity', 'If-Match': artifact['etag'], 'User-Agent': 'bio-mcp-bgee-bulk/1.0'})
        with opener(request, timeout=30) as response, temp.open('wb') as target:
            if response.status != 200 or response.headers.get('Content-Range') is not None:
                raise ValueError('Artifact requires complete HTTP 200')
            if response.headers.get('ETag') != artifact['etag'] or response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                raise ValueError('Artifact validator or content encoding changed')
            length = response.headers.get('Content-Length')
            if length is not None and (not re.fullmatch(r'[0-9]+', length) or int(length) != artifact['bytes']):
                raise ValueError('Artifact Content-Length changed')
            while chunk := response.read(65536):
                size += len(chunk)
                if size > min(artifact['bytes'], max_bytes) or time.monotonic() - started > 300:
                    raise ValueError('Artifact exceeds byte/time budget')
                digest.update(chunk)
                target.write(chunk)
        if size != artifact['bytes']:
            raise ValueError('Artifact is shorter than the manifest')
        publish(temp, output)
        return {'path': str(output), 'bytes': size, 'sha256': digest.hexdigest(), 'etag_verified': True,
                'scope': 'Complete transferred bytes; gzip/TSV integrity is verified separately during full import.'}
    finally:
        temp.unlink(missing_ok=True)
