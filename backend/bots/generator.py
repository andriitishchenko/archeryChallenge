"""
Bot score generation.
Bots simulate real users: scores are calibrated to ±10% of the user's average.
The bot flag is NEVER sent to the client — users should believe they're playing a real opponent.
"""
import random
from typing import List, Optional

# Average scores per distance and skill level (realistic archery scores)
SCORE_PROFILES = {
    "Beginner": {
        "18m": (180, 230), "25m": (160, 210), "30m": (150, 200),
        "50m": (120, 170), "70m": (100, 150), "90m": (80, 130),
    },
    "Skilled": {
        "18m": (240, 275), "25m": (220, 260), "30m": (210, 255),
        "50m": (180, 230), "70m": (160, 210), "90m": (140, 190),
    },
    "Master": {
        "18m": (280, 300), "25m": (265, 290), "30m": (260, 290),
        "50m": (240, 275), "70m": (220, 260), "90m": (200, 250),
    },
}

# Arrow scores per skill (weighted probabilities for realistic distributions)
ARROW_WEIGHTS = {
    "Beginner":  [0, 1, 2, 4, 7, 10, 13, 16, 18, 16, 13],  # index = score (0–10)
    "Skilled":   [0, 0, 1, 2, 4,  7, 10, 15, 20, 22, 19],
    "Master":    [0, 0, 0, 1, 1,  2,  4,  8, 18, 30, 36],
}

BOT_NAMES = [
    "SilentNock", "ForestGhost", "IronBrace", "StormRelease",
    "QuietArrow", "TitanDraw", "GoldenQuill", "SteelWrist",
    "SwiftFlight", "OakStave", "MistBow", "StormArrow_7",
    "ClearEye_X", "AutoNock_3", "QuantumFlight", "TargetBot_Alpha",
]


def get_bot_name() -> str:
    return random.choice(BOT_NAMES)


def generate_bot_arrows(
    arrow_count: int,
    skill_level: str = "Skilled",
    reference_score: Optional[int] = None,
    distance: str = "30m",
) -> List[int]:
    """
    Generate individual arrow scores for a bot.
    If reference_score provided, bias output to land within ±10% of that score.
    """
    weights = ARROW_WEIGHTS.get(skill_level, ARROW_WEIGHTS["Skilled"])
    scores = list(range(11))  # 0–10

    # Generate arrows until we're close to reference_score
    if reference_score and reference_score > 0:
        attempts = 0
        best_arrows = None
        best_diff = float("inf")
        target_low = reference_score * 0.90
        target_high = reference_score * 1.10

        while attempts < 50:
            arrows = random.choices(scores, weights=weights, k=arrow_count)
            total = sum(arrows)
            if target_low <= total <= target_high:
                return arrows
            diff = abs(total - reference_score)
            if diff < best_diff:
                best_diff = diff
                best_arrows = arrows
            attempts += 1
        return best_arrows or arrows

    # No reference: pure skill-level distribution
    return random.choices(scores, weights=weights, k=arrow_count)


def generate_bot_set_arrows(
    skill_level: str = "Skilled",
    opponent_set_total: Optional[int] = None,
) -> List[int]:
    """Generate 3 arrow values for a set, optionally close to opponent's set total."""
    return generate_bot_arrows(3, skill_level, opponent_set_total)


def bot_set_points(my_total: int, bot_total: int) -> tuple[int, int]:
    """Calculate set points for both players."""
    if my_total > bot_total:
        return 2, 0
    elif bot_total > my_total:
        return 0, 2
    else:
        return 1, 1


def generate_bot_profile(skill_level: str, bow_type: str) -> dict:
    """Generate a plausible bot user profile."""
    return {
        "user_id": f"bot-{random.randint(10000, 99999)}",
        "name": get_bot_name(),
        "gender": random.choice(["Male", "Female"]),
        "age": random.choice(["18–20", "21–49", "21–49", "21–49", "50+"]),
        "bow_type": bow_type,
        "skill_level": skill_level,
        "country": random.choice([
            "United States", "Germany", "United Kingdom", "Australia",
            "Netherlands", "France", "South Korea", "Canada", "Italy", "Spain"
        ]),
        "is_bot": True,  # internal only, never sent to client
    }
