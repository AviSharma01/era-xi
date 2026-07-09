from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - environment-specific dependency check.
    raise SystemExit(
        "Pillow is required to generate PNG plots. Install pillow or run with the bundled Codex Python runtime."
    ) from exc


TIERS = ("S", "A", "B", "C", "D")
TIER_THRESHOLDS = {"S": 72.0, "A": 64.0, "B": 56.0, "C": 47.0}
PROMOTED_PLAYERS = {"A Zampa", "RG Sharma"}
LABELLED_OUTLIERS = {
    "V Kohli",
    "DA Warner",
    "AB de Villiers",
    "B Kumar",
    "YS Chahal",
    "SR Watson",
    "A Zampa",
    "RG Sharma",
}


COLORS = {
    "ink": "#17212b",
    "muted": "#5d6875",
    "grid": "#d7dde4",
    "axis": "#27313d",
    "blue": "#2d6cdf",
    "green": "#16845b",
    "orange": "#c66a1b",
    "red": "#bd3d3a",
    "purple": "#7b4ab8",
    "gold": "#c19020",
    "bg": "#ffffff",
}


ROLE_COLORS = {
    "batter": "#2d6cdf",
    "wicketkeeper_batter": "#16845b",
    "bowler": "#bd3d3a",
    "bowling_all_rounder": "#7b4ab8",
    "batting_all_rounder": "#c19020",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial Bold.ttf" if bold else "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


TITLE_FONT = font(28, bold=True)
LABEL_FONT = font(16)
SMALL_FONT = font(13)
TINY_FONT = font(11)


def draw_text(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, *, fill: str = COLORS["ink"], anchor: str | None = None, font_obj: ImageFont.ImageFont = LABEL_FONT) -> None:
    draw.text(xy, text, fill=fill, font=font_obj, anchor=anchor)


def text_size(draw: ImageDraw.ImageDraw, text: str, font_obj: ImageFont.ImageFont = LABEL_FONT) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font_obj)
    return box[2] - box[0], box[3] - box[1]


class Chart:
    def __init__(self, title: str, width: int = 1100, height: int = 720) -> None:
        self.image = Image.new("RGB", (width, height), COLORS["bg"])
        self.draw = ImageDraw.Draw(self.image)
        self.width = width
        self.height = height
        self.plot = (88, 88, width - 52, height - 112)
        draw_text(self.draw, (width / 2, 30), title, anchor="ma", font_obj=TITLE_FONT)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.image.save(path)

    def x(self, value: float, lo: float, hi: float) -> float:
        left, _, right, _ = self.plot
        return left + (value - lo) / (hi - lo) * (right - left)

    def y(self, value: float, lo: float, hi: float) -> float:
        _, top, _, bottom = self.plot
        return bottom - (value - lo) / (hi - lo) * (bottom - top)

    def axes(self, x_label: str, y_label: str, x_ticks: list[float], y_ticks: list[float], x_range: tuple[float, float], y_range: tuple[float, float]) -> None:
        left, top, right, bottom = self.plot
        self.draw.line((left, bottom, right, bottom), fill=COLORS["axis"], width=2)
        self.draw.line((left, top, left, bottom), fill=COLORS["axis"], width=2)
        for tick in x_ticks:
            x = self.x(tick, *x_range)
            self.draw.line((x, top, x, bottom), fill=COLORS["grid"], width=1)
            draw_text(self.draw, (x, bottom + 12), f"{tick:g}", anchor="ma", fill=COLORS["muted"], font_obj=SMALL_FONT)
        for tick in y_ticks:
            y = self.y(tick, *y_range)
            self.draw.line((left, y, right, y), fill=COLORS["grid"], width=1)
            draw_text(self.draw, (left - 10, y), f"{tick:g}", anchor="rm", fill=COLORS["muted"], font_obj=SMALL_FONT)
        draw_text(self.draw, ((left + right) / 2, self.height - 48), x_label, anchor="ma", fill=COLORS["muted"], font_obj=LABEL_FONT)
        draw_text(self.draw, (left, top - 24), y_label, fill=COLORS["muted"], font_obj=LABEL_FONT)


def rating_values(players: list[dict[str, Any]]) -> list[float]:
    return [float(player["baseRating"]) for player in players]


def raw_base_score(player: dict[str, Any]) -> float:
    return float(player["ratingBreakdown"]["rawBaseScore"])


def tier_counts(players: list[dict[str, Any]], field: str) -> dict[str, int]:
    counts = Counter(player[field] for player in players)
    return {tier: counts.get(tier, 0) for tier in TIERS}


def role_counts(players: list[dict[str, Any]]) -> dict[str, int]:
    return dict(sorted(Counter(player["seasonRole"] for player in players).items()))


def players_in_tier(players: list[dict[str, Any]], tier: str, field: str) -> list[str]:
    return [
        player["name"]
        for player in sorted(players, key=lambda item: (-float(item["baseRating"]), item["name"], item["playerId"]))
        if player[field] == tier
    ]


def raw_context(players: list[dict[str, Any]]) -> dict[str, float]:
    first = players[0]["ratingBreakdown"]["baseRatingCalculation"]["robustStandardization"]
    return {
        "median": float(first["medianRawBaseScore"]),
        "medianAbsoluteDeviation": float(first["medianAbsoluteDeviation"]),
        "robustScaleMADTimes1_4826": float(first["robustScaleMADTimes1_4826"]),
    }


def plot_rating_distribution(players: list[dict[str, Any]], path: Path) -> None:
    values = sorted(rating_values(players))
    chart = Chart("2016 baseRating distribution")
    x_range = (0, len(values) - 1)
    y_range = (30, 84)
    chart.axes("Player-seasons ordered by baseRating", "baseRating", [0, 25, 50, 75, 100, 125, 146], [30, 40, 47, 56, 64, 72, 83], x_range, y_range)

    points = [(chart.x(index, *x_range), chart.y(value, *y_range)) for index, value in enumerate(values)]
    chart.draw.line(points, fill=COLORS["blue"], width=3)
    for threshold in (47, 56, 64, 72):
        y = chart.y(threshold, *y_range)
        chart.draw.line((chart.plot[0], y, chart.plot[2], y), fill=COLORS["orange"], width=2)
        draw_text(chart.draw, (chart.plot[2] - 6, y - 8), f"{threshold}", anchor="ra", fill=COLORS["orange"], font_obj=SMALL_FONT)

    median = statistics.median(values)
    y = chart.y(median, *y_range)
    chart.draw.line((chart.plot[0], y, chart.plot[2], y), fill=COLORS["green"], width=2)
    draw_text(chart.draw, (chart.plot[0] + 8, y - 10), f"median {median:.1f}", fill=COLORS["green"], font_obj=SMALL_FONT)
    chart.save(path)


def plot_raw_to_rating(players: list[dict[str, Any]], context: dict[str, float], path: Path) -> None:
    raw_values = [raw_base_score(player) for player in players]
    x_range = (min(raw_values) - 0.03, max(raw_values) + 0.03)
    y_range = (30, 84)
    chart = Chart("rawBaseScore to baseRating")
    chart.axes("rawBaseScore", "baseRating", [0.2, 0.4, 0.6, 0.8, 1.0, 1.2], [30, 40, 47, 56, 64, 72, 83], x_range, y_range)

    median = context["median"]
    scale = context["robustScaleMADTimes1_4826"]
    line_points = []
    for step in range(160):
        x_value = x_range[0] + (x_range[1] - x_range[0]) * step / 159
        robust_z = (x_value - median) / scale if scale else 0.0
        y_value = max(30.0, min(83.0, 56.0 + 10.0 * robust_z))
        line_points.append((chart.x(x_value, *x_range), chart.y(y_value, *y_range)))
    chart.draw.line(line_points, fill=COLORS["green"], width=3)
    draw_text(chart.draw, (chart.plot[0] + 12, chart.plot[1] + 12), "baseRating = clamp(56 + 10 * robustZ, 30, 83)", fill=COLORS["green"], font_obj=SMALL_FONT)

    for player in sorted(players, key=lambda item: item["name"]):
        x = chart.x(raw_base_score(player), *x_range)
        y = chart.y(float(player["baseRating"]), *y_range)
        color = ROLE_COLORS.get(player["seasonRole"], COLORS["blue"])
        chart.draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color, outline="#ffffff")
        if player["name"] in LABELLED_OUTLIERS:
            dx = 8
            dy = -10 if player["baseRating"] >= 72 else 8
            if player["name"] == "A Zampa":
                dx, dy = -54, 14
            elif player["name"] == "RG Sharma":
                dx, dy = -52, -2
            elif player["name"] == "YS Chahal":
                dx, dy = -62, 4
            draw_text(chart.draw, (x + dx, y + dy), player["name"], fill=COLORS["ink"], font_obj=TINY_FONT)
    chart.save(path)


def plot_ratings_by_role(players: list[dict[str, Any]], path: Path) -> None:
    grouped: dict[str, list[float]] = defaultdict(list)
    for player in players:
        grouped[player["seasonRole"]].append(float(player["baseRating"]))
    roles = sorted(grouped)
    chart = Chart("baseRating distribution by seasonRole")
    x_range = (0.5, len(roles) + 0.5)
    y_range = (30, 84)
    chart.axes("seasonRole", "baseRating", [], [30, 40, 47, 56, 64, 72, 83], x_range, y_range)

    for index, role in enumerate(roles, start=1):
        values = sorted(grouped[role])
        q1 = statistics.quantiles(values, n=4, method="inclusive")[0]
        median = statistics.median(values)
        q3 = statistics.quantiles(values, n=4, method="inclusive")[2]
        lo = min(values)
        hi = max(values)
        x = chart.x(index, *x_range)
        color = ROLE_COLORS.get(role, COLORS["blue"])
        chart.draw.line((x, chart.y(lo, *y_range), x, chart.y(hi, *y_range)), fill=color, width=2)
        chart.draw.rectangle((x - 34, chart.y(q3, *y_range), x + 34, chart.y(q1, *y_range)), fill=color, outline=COLORS["axis"])
        chart.draw.line((x - 38, chart.y(median, *y_range), x + 38, chart.y(median, *y_range)), fill="#ffffff", width=3)
        for offset_index, value in enumerate(values):
            offset = ((offset_index % 9) - 4) * 3
            y = chart.y(value, *y_range)
            chart.draw.ellipse((x + offset - 2, y - 2, x + offset + 2, y + 2), fill=COLORS["ink"])
        label = role.replace("_", "\n")
        draw_text(chart.draw, (x, chart.plot[3] + 36), label, anchor="ma", fill=COLORS["muted"], font_obj=TINY_FONT)
    chart.save(path)


def plot_tier_coverage(players: list[dict[str, Any]], path: Path) -> None:
    absolute = tier_counts(players, "absoluteTier")
    draft = tier_counts(players, "draftTier")
    chart = Chart("absoluteTier vs draftTier coverage")
    chart.plot = (92, 92, chart.width - 64, chart.height - 118)
    y_max = max(max(absolute.values()), max(draft.values())) + 6
    chart.axes("Tier", "Player count", [], list(range(0, y_max + 1, 10)), (0.5, 5.5), (0, y_max))

    bar_width = 34
    for index, tier in enumerate(TIERS, start=1):
        x = chart.x(index, 0.5, 5.5)
        for offset, counts, color, label in [(-bar_width / 2, absolute, COLORS["blue"], "absoluteTier"), (bar_width / 2, draft, COLORS["gold"], "draftTier")]:
            value = counts[tier]
            left = x + offset - bar_width / 2
            right = x + offset + bar_width / 2
            top = chart.y(value, 0, y_max)
            bottom = chart.y(0, 0, y_max)
            chart.draw.rectangle((left, top, right, bottom), fill=color)
            draw_text(chart.draw, ((left + right) / 2, top - 14), str(value), anchor="ma", font_obj=SMALL_FONT)
        draw_text(chart.draw, (x, chart.plot[3] + 14), tier, anchor="ma", fill=COLORS["muted"], font_obj=LABEL_FONT)

    promoted = [player["name"] for player in sorted(players, key=lambda item: item["name"]) if player.get("tierAdjustment") == "franchise_coverage"]
    note = "A-to-S franchise-coverage promotions: " + ", ".join(promoted)
    draw_text(chart.draw, (chart.plot[0], chart.height - 42), note, fill=COLORS["red"], font_obj=LABEL_FONT)
    legend_x = chart.plot[2] - 230
    for offset, color, label in [(0, COLORS["blue"], "absoluteTier"), (28, COLORS["gold"], "draftTier")]:
        chart.draw.rectangle((legend_x, 68 + offset, legend_x + 18, 86 + offset), fill=color)
        draw_text(chart.draw, (legend_x + 26, 66 + offset), label, font_obj=SMALL_FONT)
    chart.save(path)


def build_summary(players: list[dict[str, Any]], context: dict[str, float]) -> dict[str, Any]:
    values = rating_values(players)
    promoted = [
        {"name": player["name"], "franchise": player["franchise"], "baseRating": player["baseRating"], "absoluteTier": player["absoluteTier"], "draftTier": player["draftTier"]}
        for player in sorted(players, key=lambda item: item["name"])
        if player.get("tierAdjustment") == "franchise_coverage"
    ]
    return {
        "rating": {
            "count": len(values),
            "mean": round(sum(values) / len(values), 4),
            "median": round(statistics.median(values), 4),
            "minimum": min(values),
            "maximum": max(values),
        },
        "tierCounts": {
            "absoluteTier": tier_counts(players, "absoluteTier"),
            "draftTier": tier_counts(players, "draftTier"),
        },
        "countsByRole": role_counts(players),
        "absoluteSPlayers": players_in_tier(players, "S", "absoluteTier"),
        "draftSPlayers": players_in_tier(players, "S", "draftTier"),
        "promotedPlayers": promoted,
        "rawScore": context,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate rating-model explainability plots.")
    parser.add_argument("--processed-dir", type=Path, default=Path("data/processed/2016"))
    parser.add_argument("--output-dir", type=Path, default=Path("docs/assets"))
    args = parser.parse_args()

    players = load_json(args.processed_dir / "rated_player_seasons.json")
    load_json(args.processed_dir / "ratings_review.json")
    context = raw_context(players)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    promoted = {player["name"] for player in players if player.get("tierAdjustment") == "franchise_coverage"}
    if promoted != PROMOTED_PLAYERS:
        raise SystemExit(f"Unexpected franchise-coverage promotions: {sorted(promoted)}")

    outputs = {
        "rating_distribution": args.output_dir / "rating_distribution.png",
        "raw_score_to_rating": args.output_dir / "raw_score_to_rating.png",
        "ratings_by_role": args.output_dir / "ratings_by_role.png",
        "tier_coverage": args.output_dir / "tier_coverage.png",
        "summary": args.output_dir / "rating_analysis_summary.json",
    }

    plot_rating_distribution(players, outputs["rating_distribution"])
    plot_raw_to_rating(players, context, outputs["raw_score_to_rating"])
    plot_ratings_by_role(players, outputs["ratings_by_role"])
    plot_tier_coverage(players, outputs["tier_coverage"])
    outputs["summary"].write_text(json.dumps(build_summary(players, context), indent=2) + "\n")

    print("Generated rating analysis assets:")
    for path in outputs.values():
        print(f"- {path}")


if __name__ == "__main__":
    main()
