"""Shared local E0 checks. These do not enforce native assistant permissions."""
import hashlib
import re

PUBLIC_ROUTES = ('app.phaeacia.ai', 'phaeacia.ai/api', 'scripts/publish.py',
                 'paste it into the upload box')


def public_route(text):
    return next((route for route in PUBLIC_ROUTES if route in text), None)


def inventory(folder):
    """Hash the complete regular-file set; refuse links and unexpected cache entries.

    Python caches from preparation may remain, but assembly redirects cache lookup
    to a new empty attempt directory and disables writes before executing source.
    The manifest/inventory themselves are locally trusted, not authenticated.
    """
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError('Source root must be an ordinary directory')
    result = {}
    for path in sorted(folder.rglob('*')):
        name = str(path.relative_to(folder))
        if path.is_symlink():
            raise ValueError('Source link is not allowed: ' + name)
        if '__pycache__' in path.relative_to(folder).parts:
            if path.is_dir() and path.name == '__pycache__':
                continue
            if (path.is_file() and path.parent.name == '__pycache__'
                    and re.fullmatch(r'.+\.cpython-\d+(?:\.opt-[12])?\.pyc', path.name)):
                continue
            raise ValueError('Unexpected source cache entry: ' + name)
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError('Source entry is not a regular file: ' + name)
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result
