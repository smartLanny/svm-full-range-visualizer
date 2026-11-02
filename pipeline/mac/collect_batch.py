#!/usr/bin/env python3
"""Collect a batch of raw files from the NAS into inbox/<batch id>/ (run on the Mac).

    export NAS_ROOT="/Volumes/dav/<你的文件夹>"          # once per terminal (or --nas-root)
    python3 -I pipeline/mac/collect_batch.py --batch 2026-11-05-ip17pm-unif \\
        "手机数据整理/01单机数据/Apple iPhone 17 Pro Max/均匀性/*.json" "反射率.xml"

Every argument after the options is a path or glob RELATIVE to NAS_ROOT. Matching files are copied
(byte for byte, sha256 checked) to inbox/<batch id>/files/<same relative path>, and
inbox/<batch id>/batch.json is written (or updated) as a DRAFT: fill in "title", and for each
input "devices", "options" (and fix "type" where it says 待填写), then run
    npm run db:import -- inbox/<batch id>/batch.json --dry-run

Privacy: batch files only ever hold paths relative to NAS_ROOT. Absolute paths, "..", paths that
start at a mount point or home folder (Volumes/, Users/, …), the Mac user name and any word in the
environment variable SCREENDB_PRIVATE_WORDS (comma-separated, e.g. your folder name) are refused.
inbox/ is git-ignored: raw files are never committed (only CSV exports are kept with the batch by
db:import).

TODO (not implemented, no sample file yet): Radiant TXT matrices (2448 × 1632) should be
downsampled here to a small grid before leaving the Mac. Until then .txt files are collected as
type "radiant-txt", which db:import does not accept: they only document the batch.

Standard library only; Python 3.9+.
"""
import argparse
import getpass
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BATCH_ID_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$")
MOUNT_SEGMENTS = {"volumes", "users", "home", "mnt", "media", "private", "var", "tmp", "root"}
ABSOLUTE_IN_TEXT = re.compile(r"(?:^|[\s\"'(（「])(?:/(?:Volumes|Users|home|mnt|media|private|root)/|[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~/)")
LARGE_BYTES = 20 * 1024 * 1024
TODO_TYPE = "待填写"


class Refused(Exception):
    pass


def private_words():
    words = [w.strip() for w in re.split(r"[,\n]", os.environ.get("SCREENDB_PRIVATE_WORDS", "")) if w.strip()]
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001 - no login name available
        user = ""
    return words, {w for w in (user, Path.home().name) if len(w) >= 3}


def path_problems(rel, words, segment_words):
    out = []
    if rel.startswith(("/", "~", "\\\\")) or re.match(r"^[A-Za-z]:", rel):
        out.append("是绝对路径（只能写相对 NAS_ROOT 的路径）")
    if "\\" in rel:
        out.append("含反斜杠（用 / 分隔）")
    segs = rel.split("/")
    if any(s in ("", ".", "..") for s in segs):
        out.append("含空段、. 或 ..")
    if segs and segs[0].lower() in MOUNT_SEGMENTS:
        out.append(f"以「{segs[0]}」开头，像是挂载点或用户目录：NAS_ROOT 应设到更深一层")
    if any(w in rel for w in words):
        out.append("含有 SCREENDB_PRIVATE_WORDS 里的私人字样")
    if any(s in segment_words for s in segs):
        out.append("含有本机用户名")
    return out


def leaks(value, words, at="$"):
    if isinstance(value, str):
        out = [f"{at} 含绝对路径"] if ABSOLUTE_IN_TEXT.search(value) else []
        return out + [f"{at} 含私人字样" for w in words if w in value]
    if isinstance(value, list):
        return [x for i, v in enumerate(value) for x in leaks(v, words, f"{at}[{i}]")]
    if isinstance(value, dict):
        return [x for k, v in value.items() for x in leaks(v, words, f"{at}.{k}")]
    return []


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def guess_type(rel):
    name = rel.rsplit("/", 1)[-1].lower()
    if name.endswith(".csv"):
        return "svm-feishu-csv"
    if name.endswith(".xml"):
        return "reflectance-xml"
    if name.endswith(".json") and "uniformity" in name:
        return "uniformity-metrics"
    if name.endswith(".txt"):
        return "radiant-txt"
    return TODO_TYPE


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def collect(nas_root, batch_id, patterns, inbox_root, title=None, force=False, log=print):
    if not BATCH_ID_RE.match(batch_id):
        raise Refused(f"批次 id「{batch_id}」应为 YYYY-MM-DD-小写短名，例如 2026-11-05-ip17pm-unif")
    if not nas_root:
        raise Refused("没有 NAS_ROOT：用 --nas-root 指定，或先 export NAS_ROOT=…")
    root = Path(nas_root).expanduser().resolve()
    if not root.is_dir():
        raise Refused(f"NAS_ROOT 不是目录（NAS 挂载了吗？）")
    words, segment_words = private_words()
    for p in patterns:
        problems = path_problems(p, words, segment_words)
        if problems:
            raise Refused(f"「{p}」{'；'.join(problems)}")
    matches = []
    for p in patterns:
        found = sorted(x for x in root.glob(p) if x.is_file())
        if not found:
            raise Refused(f"NAS_ROOT 下没有匹配「{p}」的文件")
        for f in found:
            real = f.resolve()
            try:
                rel = real.relative_to(root).as_posix()
            except ValueError:
                raise Refused(f"「{p}」匹配到的文件链接到 NAS_ROOT 以外，拒绝") from None
            problems = path_problems(rel, words, segment_words)
            if problems:
                raise Refused(f"「{rel}」{'；'.join(problems)}")
            if rel not in [m[0] for m in matches]:
                matches.append((rel, real))

    batch_dir = Path(inbox_root) / batch_id
    files_dir = batch_dir / "files"
    draft_path = batch_dir / "batch.json"
    draft = json.loads(draft_path.read_text(encoding="utf-8")) if draft_path.exists() else {
        "schemaVersion": 1, "id": batch_id, "date": batch_id[:10],
        "title": title or "（待填写：一句话说明这批数据）", "notes": "", "inputs": [],
    }
    if draft.get("id") != batch_id:
        raise Refused(f"{draft_path} 属于另一个批次 {draft.get('id')}")
    if title:
        draft["title"] = title
    by_path = {i.get("path"): i for i in draft.get("inputs", [])}
    total = 0
    rows = []
    plan = []
    for rel, src in matches:
        digest = sha256_file(src)
        size = src.stat().st_size
        dst = files_dir.joinpath(*rel.split("/"))
        if dst.exists() and sha256_file(dst) != digest and not force:
            raise Refused(f"inbox 里已有不同内容的「{rel}」：NAS 上的文件变了？确认后加 --force 覆盖")
        plan.append((rel, src, dst, digest, size))
    for rel, src, dst, digest, size in plan:
        if not dst.exists() or sha256_file(dst) != digest:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
            if sha256_file(dst) != digest:
                raise Refused(f"复制「{rel}」后 sha256 不一致（读取 NAS 时出错？）")
        entry = by_path.get(rel)
        if entry is None:
            entry = {"path": rel, "sha256": digest, "bytes": size, "type": guess_type(rel), "devices": [], "notes": "", "options": {}}
            draft.setdefault("inputs", []).append(entry)
            by_path[rel] = entry
            status = "新增"
        elif entry.get("sha256") != digest:
            entry["sha256"], entry["bytes"] = digest, size
            status = "已更新（文件变了）"
        else:
            status = "不变"
        total += size
        rows.append((rel, size, entry["type"], status))
    problems = leaks(draft, words)
    if problems:
        raise Refused(f"草稿 batch.json 里有绝对路径或私人字样：{'；'.join(problems)}")
    batch_dir.mkdir(parents=True, exist_ok=True)
    draft_path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    log(f"批次 {batch_id}：{len(rows)} 个文件，共 {human(total)}，已复制到 {batch_dir / 'files'}")
    for rel, size, kind, status in rows:
        flag = "  ← 超过 20 MB" if size > LARGE_BYTES else ""
        log(f"  {status:6} {human(size):>9}  [{kind}] {rel}{flag}")
    if any(r[2] == "radiant-txt" for r in rows):
        log("注意：Radiant TXT 的降采样还没实现（缺样本文件），db:import 暂不接受 radiant-txt 类型。")
    if any(r[2] == TODO_TYPE for r in rows):
        log(f"注意：有文件认不出类型，请在 batch.json 里把 type「{TODO_TYPE}」改成 svm-feishu-csv / uniformity-metrics / reflectance-xml。")
    log(f"下一步：编辑 {draft_path}（title；每个输入的 devices、options），然后")
    log(f"  npm run db:import -- {draft_path} --dry-run")
    return {"batch": batch_id, "files": [{"path": r[0], "bytes": r[1], "type": r[2], "status": r[3]} for r in rows],
            "totalBytes": total, "draft": str(draft_path)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("patterns", nargs="+", help="相对 NAS_ROOT 的路径或通配符（可用 **）")
    parser.add_argument("--batch", required=True, help="批次 id：YYYY-MM-DD-短名")
    parser.add_argument("--nas-root", default=os.environ.get("NAS_ROOT"), help="NAS 上你的文件夹（默认取环境变量 NAS_ROOT）")
    parser.add_argument("--inbox-root", default=str(REPO / "inbox"), help="收件箱目录（默认仓库里的 inbox/）")
    parser.add_argument("--title", help="批次标题（一句话）")
    parser.add_argument("--force", action="store_true", help="inbox 里已有同名但内容不同的文件时覆盖")
    parser.add_argument("--json", action="store_true", help="最后一行输出 JSON 摘要")
    args = parser.parse_args(argv)
    try:
        result = collect(args.nas_root, args.batch, args.patterns, args.inbox_root, args.title, args.force)
    except Refused as exc:
        print(f"拒绝：{exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
