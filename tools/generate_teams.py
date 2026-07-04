#!/usr/bin/env python3
"""国別チームのロスター(20人)を生成し teams/*.md と js/teams-data.js を出力する。

バランス保証:
- 全チームのスカッド総合値(20人x8能力の合計)を SQUAD_TOTAL に完全一致させる
- チームの個性は「合計」ではなく「配分」(アーキタイプ補正と分散)で表現する

再生成: python3 tools/generate_teams.py
SEED を変えなければ出力は毎回同じ(コミットされた .md と一致する)。
"""

import json
import random
from pathlib import Path

SEED = 20260704
SQUAD_TOTAL = 9000          # 20人 x 8能力 の合計値(全チーム共通)
STAT_MIN, STAT_MAX = 25, 95

STATS = ["スピード", "パス", "ドリブル", "シュート", "守備", "空中戦", "スタミナ", "メンタル"]

# ポジション別の基準値(平均的なチームの場合)。GKの「守備」はセービング能力を兼ねる
BASE = {
    "GK": [45, 50, 35, 25, 70, 65, 55, 65],
    "DF": [50, 55, 45, 40, 70, 65, 60, 60],
    "MF": [55, 65, 58, 52, 55, 52, 65, 58],
    "FW": [62, 55, 62, 68, 38, 58, 60, 60],
}
SQUAD_SHAPE = [("GK", 2), ("DF", 7), ("MF", 7), ("FW", 4)]

# アーキタイプ補正(各チーム合計ゼロ)。順序は STATS と同じ
# [スピード, パス, ドリブル, シュート, 守備, 空中戦, スタミナ, メンタル]
TEAMS = [
    {
        "file": "japan", "name": "日本",
        "mod": [4, 6, 2, -4, -2, -9, 5, -2],
        "sigma": 5, "stars": 0,
        "desc": "平均身長は参加チーム中もっとも低い。だが90分間、彼らの足は止まらない。",
    },
    {
        "file": "spain", "name": "スペイン",
        "mod": [-4, 10, 3, -2, -1, -6, -2, 2],
        "sigma": 5, "stars": 0,
        "desc": "彼らの練習は、輪になったパス回しから始まり、パス回しで終わるという。",
    },
    {
        "file": "brazil", "name": "ブラジル",
        "mod": [4, 2, 10, 4, -7, -6, -4, -3],
        "sigma": 7, "stars": 0,
        "desc": "路地裏のリズムで育った男たち。1対1で彼らを止められた者は幸運だ。",
    },
    {
        "file": "england", "name": "イングランド",
        "mod": [-1, -5, -7, 3, 2, 9, 4, -5],
        "sigma": 5, "stars": 0,
        "desc": "霧の国から来た屈強な男たち。ゴール前に上がるボールは、彼らへのご馳走だ。",
    },
    {
        "file": "germany", "name": "ドイツ",
        "mod": [-3, 1, -8, -8, 4, 3, 8, 3],
        "sigma": 4, "stars": 0,
        "desc": "規律、走力、そしてまた規律。彼らの辞書に「疲労」の文字はない……ように見える。",
    },
    {
        "file": "italy", "name": "イタリア",
        "mod": [-5, -4, -4, 1, 9, 2, -6, 7],
        "sigma": 5, "stars": 0,
        "desc": "カテナチオの末裔。彼らのゴール前には、見えない鎖が張られている。",
    },
    {
        "file": "france", "name": "フランス",
        "mod": [9, -6, 2, 3, 2, 3, -4, -9],
        "sigma": 6, "stars": 0,
        "desc": "陸上チームと間違えてはいけない。置き去りにされてから気づいても、もう遅い。",
    },
    {
        "file": "argentina", "name": "アルゼンチン",
        "mod": [-4, 1, 4, 4, -3, -5, -5, 8],
        "sigma": 8, "stars": 2,
        "desc": "タンゴの国のエースは、たった一人で試合を決める。彼にボールを預けろ——それが約束だ。",
    },
    {
        "file": "netherlands", "name": "オランダ",
        "mod": [0, 0, 0, 0, 0, 0, 0, 0],
        "sigma": 3, "stars": 0,
        "desc": "全員が攻め、全員が守る。ポジションは、彼らにとってただの背番号にすぎない。",
    },
    {
        "file": "portugal", "name": "ポルトガル",
        "mod": [5, 1, 7, 2, -5, -3, -3, -4],
        "sigma": 6, "stars": 0,
        "desc": "大西洋の風とともにサイドを駆け上がる。狭い道こそ、彼らの独壇場だ。",
    },
]

NAMES = {
    "japan": ["サトウ", "スズキ", "タカハシ", "タナカ", "ワタナベ", "イトウ", "ヤマモト",
              "ナカムラ", "コバヤシ", "カトウ", "ヨシダ", "ヤマダ", "ササキ", "ヤマグチ",
              "マツモト", "イノウエ", "キムラ", "ハヤシ", "シミズ", "モリ"],
    "spain": ["ガルシア", "フェルナンデス", "ゴンサレス", "ロドリゲス", "ロペス", "マルティネス",
              "サンチェス", "ペレス", "ゴメス", "マルティン", "ヒメネス", "エルナンデス",
              "ルイス", "ディアス", "モレノ", "アルバレス", "ロメロ", "ナバーロ", "トーレス", "ラモス"],
    "brazil": ["シウバ", "サントス", "オリヴェイラ", "ソウザ", "ペレイラ", "リマ", "カルヴァーリョ",
               "フェレイラ", "ホドリゲス", "アウヴェス", "モンテイロ", "バルボーザ", "カストロ",
               "ヒベイロ", "マルチンス", "アラウージョ", "メロ", "モウラ", "バチスタ", "ナシメント"],
    "england": ["スミス", "ジョーンズ", "テイラー", "ブラウン", "ウィリアムズ", "ウィルソン",
                "ジョンソン", "デイヴィス", "ロビンソン", "ライト", "トンプソン", "エヴァンス",
                "ウォーカー", "ホワイト", "ヒューズ", "グリーン", "ホール", "クラーク",
                "ハリソン", "ベイカー"],
    "germany": ["ミュラー", "シュミット", "シュナイダー", "フィッシャー", "ウェーバー", "マイヤー",
                "ワーグナー", "ベッカー", "シュルツ", "ホフマン", "ケーラー", "リヒター",
                "クライン", "ヴォルフ", "ノイマン", "シュヴァルツ", "ツィンマーマン",
                "クルーガー", "ハルトマン", "ランゲ"],
    "italy": ["ロッシ", "ルッソ", "フェラーリ", "エスポジト", "ビアンキ", "ロマーノ", "コロンボ",
              "リッチ", "マリーノ", "グレコ", "ブルーノ", "ガッロ", "コンティ", "デ・ルーカ",
              "マンチーニ", "コスタ", "ジョルダーノ", "リッツォ", "ロンバルディ", "モレッティ"],
    "france": ["マルタン", "ベルナール", "デュボワ", "トマ", "ロベール", "リシャール", "プティ",
               "デュラン", "ルロワ", "モロー", "シモン", "ローラン", "ルフェーヴル", "ミシェル",
               "フォンテーヌ", "ダヴィド", "ベルトラン", "ルー", "ヴァンサン", "フルニエ"],
    "argentina": ["アコスタ", "ベニテス", "カブレラ", "ドミンゲス", "ソサ", "アギーレ", "メンドサ",
                  "オルティス", "バスケス", "ヌニェス", "ロハス", "モリーナ", "スアレス",
                  "パチェコ", "レデスマ", "ポンセ", "バレーラ", "フィゲロア", "ブスタマンテ",
                  "アルディレス"],
    "netherlands": ["デ・フリース", "ヤンセン", "ファン・デン・ベルフ", "バッカー", "フィッセル",
                    "スミット", "メイヤー", "デ・ブール", "ムルダー", "ボス", "ペーテルス",
                    "ヘンドリクス", "デッケル", "ブラウワー", "ディクストラ", "クイパー",
                    "ファン・レーウェン", "ポストマ", "ティンメルマンス", "スホルテン"],
    "portugal": ["コエーリョ", "カルドーゾ", "パイヴァ", "タヴァレス", "フォンセカ", "マチャド",
                 "ピント", "ヴィエイラ", "ゴンサウヴェス", "アゼヴェード", "モライス", "クルス",
                 "ブランダオン", "テイシェイラ", "ノゲイラ", "ドゥアルテ", "ファリア", "ミランダ",
                 "アブレウ", "レイテ"],
}

# エース(stars)が強化される能力: ドリブル, シュート, パス, メンタル
# 総合値はスカッド単位で9000に正規化されるため、エースを尖らせるほど控えが薄くなる。
# ただし先発11人の格差が開きすぎないよう、ボーナスは控えめにする。
STAR_STATS = [2, 3, 1, 7]
STAR_BONUS = 8


def clamp(v):
    return max(STAT_MIN, min(STAT_MAX, int(round(v))))


def generate_team(rng, team):
    players = []
    names = list(NAMES[team["file"]])
    rng.shuffle(names)
    for pos, count in SQUAD_SHAPE:
        for _ in range(count):
            stats = []
            for i, base in enumerate(BASE[pos]):
                v = base + team["mod"][i] + rng.gauss(0, team["sigma"])
                stats.append(clamp(v))
            players.append({"name": names.pop(), "pos": pos, "stats": stats})

    # エース設定: MF/FW から stars 人を選び主要能力を底上げ(総合値は後段の正規化で吸収)
    if team["stars"]:
        candidates = [p for p in players if p["pos"] in ("MF", "FW")]
        aces = rng.sample(candidates, team["stars"])
        for p in aces:
            for i in STAR_STATS:
                p["stats"][i] = clamp(p["stats"][i] + STAR_BONUS)

    # スカッド総合値を SQUAD_TOTAL に完全一致させる(±1ずつランダムに調整)
    def total():
        return sum(sum(p["stats"]) for p in players)

    while total() != SQUAD_TOTAL:
        diff = SQUAD_TOTAL - total()
        p = rng.choice(players)
        i = rng.randrange(len(STATS))
        v = p["stats"][i]
        if diff > 0 and v < STAT_MAX:
            p["stats"][i] = v + 1
        elif diff < 0 and v > STAT_MIN:
            p["stats"][i] = v - 1
    return players


def render_md(team, players):
    lines = [f"# {team['name']}代表", "",
             f"> {team['desc']}", "",
             f"スカッド総合値: {SQUAD_TOTAL}（全チーム共通）", "",
             "| # | 名前 | Pos | " + " | ".join(STATS) + " |",
             "|---|---|---|" + "---|" * len(STATS)]
    for num, p in enumerate(players, start=1):
        row = f"| {num} | {p['name']} | {p['pos']} | " + \
              " | ".join(str(v) for v in p["stats"]) + " |"
        lines.append(row)
    lines += ["",
              "※ 能力は 25〜95。GK の「守備」はセービング能力を兼ねる。",
              "※ このファイルは tools/generate_teams.py により生成される。手動編集しないこと。"]
    return "\n".join(lines) + "\n"


def render_js(all_teams):
    data = {}
    for team, players in all_teams:
        data[team["file"]] = {
            "name": team["name"],
            "desc": team["desc"],
            "players": [{"name": p["name"], "pos": p["pos"], "stats": p["stats"]}
                        for p in players],
        }
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return ("// tools/generate_teams.py により生成される。手動編集しないこと。\n"
            f"const STAT_NAMES = {json.dumps(STATS, ensure_ascii=False)};\n"
            f"const SQUAD_TOTAL = {SQUAD_TOTAL};\n"
            f"const TEAMS_DATA = {body};\n")


def main():
    rng = random.Random(SEED)
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "teams"
    out_dir.mkdir(exist_ok=True)
    all_teams = []
    print(f"{'チーム':<8} 総合値  ベストXI概算")
    for team in TEAMS:
        players = generate_team(rng, team)
        all_teams.append((team, players))
        (out_dir / f"{team['file']}.md").write_text(render_md(team, players), encoding="utf-8")
        # ベストXI概算(公平性チェック用): 各ポジション上位を 1-4-4-2 で単純選抜
        by_pos = {pos: sorted((p for p in players if p["pos"] == pos),
                              key=lambda p: -sum(p["stats"])) for pos, _ in SQUAD_SHAPE}
        xi = by_pos["GK"][:1] + by_pos["DF"][:4] + by_pos["MF"][:4] + by_pos["FW"][:2]
        squad_total = sum(sum(p["stats"]) for p in players)
        xi_total = sum(sum(p["stats"]) for p in xi)
        print(f"{team['name']:<8} {squad_total}   {xi_total}")

    js_dir = root / "js"
    js_dir.mkdir(exist_ok=True)
    (js_dir / "teams-data.js").write_text(render_js(all_teams), encoding="utf-8")
    print("js/teams-data.js を出力しました")


if __name__ == "__main__":
    main()
