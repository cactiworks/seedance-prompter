import argparse
import collections
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request


def read_json(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return json.load(response)


def atomic_json(path, value):
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def file_hash(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def upload(base, origin, name, path):
    address = urllib.parse.urlsplit(base)
    connection_type = http.client.HTTPSConnection if address.scheme == 'https' else http.client.HTTPConnection
    connection = connection_type(address.hostname, address.port, timeout=600)
    target = address.path.rstrip('/') + '/api/references/imports?' + urllib.parse.urlencode({'name': name})
    try:
        connection.putrequest('POST', target)
        for header, value in {'Origin': origin, 'x-sp-client': 'reference-batch',
                              'Content-Type': 'video/mp4', 'Content-Length': str(path.stat().st_size)}.items():
            connection.putheader(header, value)
        connection.endheaders()
        with path.open('rb') as source:
            while block := source.read(1024 * 1024):
                connection.send(block)
        response = connection.getresponse()
        body = response.read()
        try:
            data = json.loads(body)
        except ValueError:
            data = {'error': 'Ответ импорта не содержит JSON'}
        return response.status, data
    finally:
        connection.close()


def prepare(source, target):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
                    '-i', str(source), '-map', '0:v:0',
                    '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18',
                    '-an', '-map_metadata', '-1', '-movflags', '+faststart', str(target)],
                   check=True, timeout=900, capture_output=True)


def interrupt(signum, frame):
    raise KeyboardInterrupt()


def main():
    parser = argparse.ArgumentParser(description='Импорт первых N видео Яндекс Диска через API библиотеки, без запуска AI.')
    parser.add_argument('--public-url', required=True)
    parser.add_argument('--base-url', default='http://127.0.0.1:4317')
    parser.add_argument('--origin', required=True)
    parser.add_argument('--count', type=int, default=50)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--temp-root', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.count <= 100:
        parser.error('--count должен быть от 1 до 100')
    if urllib.parse.urlsplit(args.base_url).hostname not in ('127.0.0.1', 'localhost'):
        parser.error('Импорт запускается на сервере через loopback API')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.temp_root / 'import.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker = args.temp_root / '.reference-import-owner'
        owner = hashlib.sha256((args.public_url + '\n' + str(args.report.resolve())).encode()).hexdigest()
        if marker.exists():
            if marker.read_text() != owner:
                raise RuntimeError('Рабочий каталог принадлежит другому пакетному импорту')
        else:
            if any(entry.name != 'import.lock' for entry in args.temp_root.iterdir()):
                raise RuntimeError('Для импорта нужен отдельный пустой рабочий каталог')
            marker.write_text(owner)
            marker.chmod(0o600)
        for stale in args.temp_root.glob('source-*'):
            if stale.is_dir() and not stale.is_symlink():
                shutil.rmtree(stale)
        for event in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(event, interrupt)
        api = 'https://cloud-api.yandex.net/v1/disk/public/resources'
        query = urllib.parse.urlencode({'public_key': args.public_url, 'limit': 100, 'sort': 'name'})
        items = read_json(api + '?' + query)['_embedded']['items']
        report = {'publicUrl': args.public_url, 'selectionOrder': 'name', 'requestedVideos': args.count,
                  'startedAt': time.time(), 'modelCalls': 0, 'items': []}
        if args.report.exists():
            report = json.loads(args.report.read_text())
            if report['publicUrl'] != args.public_url or report['requestedVideos'] != args.count:
                raise RuntimeError('Существующий отчёт принадлежит другому импорту')
        if 'selection' not in report:
            report['selection'] = [{key: item.get(key) for key in ('name', 'path', 'size', 'sha256')}
                                   for item in items if item['type'] == 'file' and
                                   item['name'].lower().endswith(('.mp4', '.mov', '.webm'))][:args.count]
        selected = report['selection']
        if len(selected) != args.count:
            raise RuntimeError('В источнике недостаточно видео для указанного количества')
        current = {item['path']: item for item in items}
        for item in selected:
            observed = current.get(item['path'])
            if not observed or any(observed.get(key) != item.get(key) for key in ('size', 'sha256')):
                raise RuntimeError('Состав или содержимое зафиксированной выборки изменилось')
        atomic_json(args.report, report)
        previous = {item['path']: item for item in report['items']}
        existing = read_json(args.base_url + '/api/references/cards?scope=all')['cards']
        by_source = collections.defaultdict(list)
        for card in existing:
            by_source[card['id'].rsplit('-', 1)[0]].append(card)

        def save_record(record):
            previous[record['path']] = record
            report['items'] = [previous[item['path']] for item in selected if item['path'] in previous]
            atomic_json(args.report, report)

        for position, item in enumerate(selected, 1):
            record = {'position': position, 'name': item['name'], 'path': item['path'],
                      'sourceBytes': item['size'], 'sourceSha256': item.get('sha256')}
            old = previous.get(item['path'])
            if old and old.get('status') == 'imported' and old.get('sourceSha256') != item.get('sha256'):
                raise RuntimeError('Содержимое ранее импортированного исходника изменилось')
            source_ids = old.get('sourceIds', []) if old and old.get('status') == 'imported' else []
            if not source_ids and item.get('sha256'):
                source_ids = ['rf-' + item['sha256']]
            if source_ids and all(source_id in by_source for source_id in source_ids):
                record.update(old or {})
                record.update(status='imported', existing=True,
                              frames=sum(len(by_source[source_id]) for source_id in source_ids), sourceIds=source_ids)
                print(json.dumps(record, ensure_ascii=False), flush=True)
                save_record(record)
                continue
            print(f'{position}/{args.count}: {item["name"]}', flush=True)
            try:
                if item['size'] > 150 * 1024 * 1024:
                    raise RuntimeError('Источник превышает 150 МБ')
                if shutil.disk_usage(args.temp_root).free < item['size'] * 2 + 300 * 1024 * 1024:
                    raise RuntimeError('Недостаточно места для безопасного последовательного импорта')
                with tempfile.TemporaryDirectory(prefix='source-', dir=args.temp_root) as directory:
                    original = Path(directory) / ('original' + Path(item['name']).suffix)
                    download = read_json(api + '/download?' + urllib.parse.urlencode(
                        {'public_key': args.public_url, 'path': item['path']}))['href']
                    with urllib.request.urlopen(download, timeout=120) as response, original.open('wb') as target:
                        downloaded = 0
                        while block := response.read(1024 * 1024):
                            downloaded += len(block)
                            if downloaded > item['size']:
                                raise RuntimeError('Скачанный поток превышает размер исходника')
                            target.write(block)
                    if original.stat().st_size != item['size']:
                        raise RuntimeError('Размер скачанного видео не совпадает с источником')
                    original_hash = file_hash(original)
                    if item.get('sha256') and original_hash != item['sha256']:
                        raise RuntimeError('SHA-256 скачанного видео не совпадает с источником')
                    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                                            '-show_entries', 'stream=width,height:format=duration', '-of', 'json',
                                            str(original)], check=True, capture_output=True, text=True, timeout=30)
                    info = json.loads(probe.stdout)
                    record['durationSeconds'] = float(info['format']['duration'])
                    if record['durationSeconds'] > 180:
                        raise RuntimeError('Видео длиннее трёх минут')
                    frame = info['streams'][0]
                    normalized = Path(directory) / 'prepared.mp4'
                    use_prepared = max(frame['width'], frame['height']) > 1920 or item['size'] > 60 * 1024 * 1024
                    if use_prepared:
                        prepare(original, normalized)
                    source = normalized if use_prepared else original
                    upload_name = item['name'] + '.mp4' if use_prepared and item['name'].lower().endswith('.webm') else item['name']
                    status, result = upload(args.base_url, args.origin, upload_name, source)
                    if status == 422 and not use_prepared:
                        record['initialImportError'] = result.get('messageRu', result.get('error'))
                        prepare(original, normalized)
                        source = normalized
                        use_prepared = True
                        upload_name = item['name'] + '.mp4' if item['name'].lower().endswith('.webm') else item['name']
                        status, result = upload(args.base_url, args.origin, upload_name, source)
                    if status != 200:
                        raise RuntimeError(f'HTTP {status}: {result.get("messageRu", result.get("error"))}')
                    cards = result['cards']
                    if not cards:
                        raise RuntimeError('Импорт не вернул ни одного кандидата')
                    record.update(status='imported', frames=len(cards), normalized=use_prepared,
                                  uploadName=upload_name,
                                  importedBytes=source.stat().st_size, importedSha256=file_hash(source),
                                  sourceIds=sorted({card['id'].rsplit('-', 1)[0] for card in cards}))
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, http.client.HTTPException) as error:
                record.update(status='error', error=str(error)[:500])
            record['temporaryFilesRemoved'] = not any(args.temp_root.glob('source-*'))
            save_record(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
        report['finishedAt'] = time.time()
        report['importedVideos'] = sum(item['status'] == 'imported' for item in report['items'])
        report['candidateFrames'] = sum(item.get('frames', 0) for item in report['items'])
        report['temporaryFilesRemaining'] = len(list(args.temp_root.glob('source-*')))
        atomic_json(args.report, report)
        if report['importedVideos'] != args.count:
            raise SystemExit('Некоторые видео не импортированы; отчёт сохранён для повторного запуска')


if __name__ == '__main__':
    main()
