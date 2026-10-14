"""S0 recon: anonymous probe of bilibili subtitle/audio availability for English videos."""
import hashlib, json, os, re, sys, time, urllib.parse, urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
         33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
         61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
         36, 20, 34, 44, 52]

def get(url, referer="https://www.bilibili.com", cookie=""):
    import gzip
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": referer, "Accept-Encoding": "gzip",
        **({"Cookie": cookie} if cookie else {})})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip" or data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        return data.decode("utf-8", "replace")

def get_json(url, **kw):
    return json.loads(get(url, **kw))

def wbi_keys():
    nav = get_json("https://api.bilibili.com/x/web-interface/nav")["data"]["wbi_img"]
    img = nav["img_url"].rsplit("/", 1)[1].split(".")[0]
    sub = nav["sub_url"].rsplit("/", 1)[1].split(".")[0]
    return "".join((img + sub)[i] for i in MIXIN)[:32]

def wbi_signed(endpoint, params, key):
    params = dict(params, wts=int(time.time()))
    qs = "&".join(f"{k}={urllib.parse.quote(str(v), safe='')}"
                  for k, v in sorted(params.items()) if k != "w_rid")
    params["w_rid"] = hashlib.md5((qs + key).encode()).hexdigest()
    return endpoint + "?" + urllib.parse.urlencode(params)

def main():
    key = wbi_keys()
    print("wbi mixin key:", key)

    # 1. search English videos (wbi-signed)
    search = get_json(wbi_signed(
        "https://api.bilibili.com/x/web-interface/wbi/search/type",
        {"search_type": "video", "keyword": "TED演讲 纯英文", "order": "click",
         "page": 1, "duration": 1}, key))
    if search.get("code") != 0:
        print("SEARCH FAILED", search.get("code"), search.get("message"))
        return
    picks = []
    for r in search["data"]["result"]:
        title = re.sub(r"<.*?>", "", r["title"])
        m = re.match(r"(\d+):(\d+)", r.get("duration", ""))
        secs = int(m[1]) * 60 + int(m[2]) if m else 0
        if 120 <= secs <= 1500:
            picks.append({"bvid": r["bvid"], "title": title, "secs": secs,
                          "author": r.get("author", "")})
        if len(picks) >= 6:
            break
    print(f"\n== search picks ({len(picks)}) ==")
    for p in picks:
        print(" ", p["bvid"], f"{p['secs']//60}m{p['secs']%60:02d}s", p["title"][:48], "|", p["author"])

    # 2. per video: page HTML -> __INITIAL_STATE__ -> subtitle list; then wbi/v2 + playurl
    report = []
    for p in picks[:4]:
        bvid = p["bvid"]
        html = get(f"https://www.bilibili.com/video/{bvid}/")
        m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*\(function", html, re.S)
        if not m:
            m = re.search(r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\});", html, re.S)
        info = {"bvid": bvid, "title": p["title"]}
        if not m:
            info["page_error"] = "INITIAL_STATE not found"
            report.append(info); continue
        raw = re.sub(r"\bundefined\b", "null", m.group(1))
        try:
            st = json.loads(raw)
        except Exception as e:
            info["page_error"] = f"parse fail: {e}"
            report.append(info); continue
        vd = st.get("videoData") or {}
        info.update(aid=vd.get("aid"), cid=vd.get("cid"))
        subs = (vd.get("subtitle") or {}).get("list") or []
        info["page_subtitle_list"] = [
            {"lan": s.get("lan"), "lan_doc": s.get("lan_doc"), "ai_status": s.get("ai_status"),
             "has_url": bool(s.get("subtitle_url"))} for s in subs]
        # anonymous player info (the endpoint the client itself calls)
        pv = get_json(wbi_signed(
            "https://api.bilibili.com/x/player/wbi/v2",
            {"aid": vd.get("aid"), "cid": vd.get("cid")}, key))
        info["player_v2_code"] = pv.get("code")
        if pv.get("code") == 0:
            d = pv.get("data", {})
            info["need_login_subtitle"] = d.get("need_login_subtitle")
            info["player_v2_subtitles"] = [
                {"lan": s.get("lan"), "lan_doc": s.get("lan_doc"), "ai_type": s.get("ai_type"),
                 "has_url": bool(s.get("subtitle_url"))} for s in (d.get("subtitle") or {}).get("subtitles", [])]
            # fetch first available subtitle body (anonymous URL if present)
            for s in (d.get("subtitle") or {}).get("subtitles", []):
                u = s.get("subtitle_url", "")
                if u:
                    body = get("https:" + u if u.startswith("//") else u)
                    fn = os.path.join(OUT, f"{bvid}_{s['lan']}.json")
                    open(fn, "w", encoding="utf-8").write(body)
                    b = json.loads(body)
                    info["subtitle_sample"] = {
                        "lan": s["lan"], "lines": len(b.get("body", [])),
                        "first": b.get("body", [])[:2], "saved": fn}
                    break
        # anonymous playurl for dash audio
        pu = get_json(wbi_signed(
            "https://api.bilibili.com/x/player/wbi/playurl",
            {"avid": vd.get("aid"), "cid": vd.get("cid"), "fnval": 16, "fnver": 0,
             "qn": 32, "type": 4}, key))
        info["playurl_code"] = pu.get("code")
        if pu.get("code") == 0:
            dash = (pu.get("data", {}).get("dash") or {})
            auds = dash.get("audio") or []
            info["dash_audio"] = [
                {"id": a.get("id"), "host": urllib.parse.urlparse(a.get("baseUrl") or a.get("base_url") or "").netloc}
                for a in auds]
        report.append(info)
        print(json.dumps(info, ensure_ascii=False, indent=1)[:1800])
        print("-" * 70)

    json.dump(report, open(os.path.join(OUT, "s0_report.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("saved ->", os.path.join(OUT, "s0_report.json"))

if __name__ == "__main__":
    main()
