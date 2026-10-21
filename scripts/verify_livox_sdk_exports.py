#!/usr/bin/env python3
"""Check the SDK public C API and reject exported implementation symbols."""
import argparse
import ctypes
import json
from pathlib import Path
import re
import subprocess


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('library', type=Path)
    args = parser.parse_args()
    include = root/'third_party/Livox-SDK2/include'
    public = set(re.findall(r'^(?:void|bool|livox_status|uint16_t)\s+(\w+)\s*\(',
                            (include/'livox_lidar_api.h').read_text(), re.M))
    output = subprocess.check_output(
        ['nm', '-D', '--defined-only', str(args.library.resolve())], text=True)
    actual = {line.split()[-1] for line in output.splitlines()}
    if not public or actual != public:
        raise SystemExit('SDK exports differ: missing='+repr(sorted(public-actual))
                         +'; unexpected='+repr(sorted(actual-public)))

    class Version(ctypes.Structure):
        _fields_ = [('major', ctypes.c_int), ('minor', ctypes.c_int), ('patch', ctypes.c_int)]

    sdk = ctypes.CDLL(str(args.library.resolve()))
    sdk.GetLivoxLidarSdkVer.argtypes = [ctypes.POINTER(Version)]
    sdk.GetLivoxLidarSdkVer.restype = None
    version = Version()
    sdk.GetLivoxLidarSdkVer(ctypes.byref(version))
    expected = [int(re.search(r'#define\s+LIVOX_LIDAR_SDK_'+part+r'_VERSION\s+(\d+)',
                             (include/'livox_lidar_def.h').read_text()).group(1))
                for part in ('MAJOR', 'MINOR', 'PATCH')]
    if [version.major, version.minor, version.patch] != expected:
        raise SystemExit('SDK runtime version does not match repository headers')
    print(json.dumps({'library': str(args.library.resolve()), 'public_symbols': len(public),
                      'sdk_version': '.'.join(map(str, expected))}, indent=2))


if __name__ == '__main__':
    main()
