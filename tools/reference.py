"""Независимая референс-реализация статистики для сверки с src/stats.js.

Только стандартная библиотека: math.erf + регулярные аппроксимации
неполной гамма-функции (NR) и неполной бета-функции (NR).

Запуск:  python tools/reference.py
Результат копируется в tests.html как ожидаемые значения.
"""

import math

# ---------------------------------------------------------------- гамма


def _gser(a: float, x: float, itmax: int = 500, eps: float = 3e-16) -> float:
    """Регулярная аппроксимация P(a, x) = lower incomplete gamma / Gamma(a)."""
    if x <= 0.0:
        return 0.0
    ap = a
    s = 1.0 / a
    d = s
    for _ in range(itmax):
        ap += 1.0
        d *= x / ap
        s += d
        if abs(d) < abs(s) * eps:
            break
    return s * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _gcf(a: float, x: float, itmax: int = 500, eps: float = 3e-16) -> float:
    """Аппроксимация Q(a, x) = 1 - P(a, x) через непрерывную дробь."""
    tiny = 1e-300
    b = x + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, itmax + 1):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h * math.exp(-x + a * math.log(x) - math.lgamma(a))


def gammq(a: float, x: float) -> float:
    """Верхняя неполная гамма-функция, нормированная: Q(a, x)."""
    if x < 0.0 or a <= 0.0:
        raise ValueError("gammq: требуются a > 0 и x >= 0")
    if x == 0.0:
        return 1.0
    if x < a + 1.0:
        return 1.0 - _gser(a, x)
    return _gcf(a, x)


# ---------------------------------------------------------------- бета


def _betacf(a: float, b: float, x: float, itmax: int = 500, eps: float = 3e-16) -> float:
    tiny = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < tiny:
        d = tiny
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < tiny:
            d = tiny
        c = 1.0 + aa / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def betai(a: float, b: float, x: float) -> float:
    """Нормированная неполная бета-функция I_x(a, b)."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    bt = math.exp(
        math.lgamma(a + b)
        - math.lgamma(a)
        - math.lgamma(b)
        + a * math.log(x)
        + b * math.log1p(-x)
    )
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


# ---------------------------------------------------------------- нормальное


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def norm_inv(p: float) -> float:
    lo, hi = -40.0, 40.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if norm_cdf(mid) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------- тесты


def prop_z_test(xa: int, na: int, xb: int, nb: int) -> dict:
    """Двухдольный z-тест для долей (пул для SE, независимый для ДИ)."""
    pa, pb = xa / na, xb / nb
    ppool = (xa + xb) / (na + nb)
    se_pool = math.sqrt(ppool * (1 - ppool) * (1.0 / na + 1.0 / nb))
    z = (pb - pa) / se_pool
    se_diff = math.sqrt(pa * (1 - pa) / na + pb * (1 - pb) / nb)
    diff = pb - pa
    zc = norm_inv(0.975)
    return {
        "pa": pa,
        "pb": pb,
        "diff": diff,
        "relLift": diff / pa,
        "z": z,
        "pValue": 2.0 * (1.0 - norm_cdf(abs(z))),
        "ciLo": diff - zc * se_diff,
        "ciHi": diff + zc * se_diff,
    }


def welch_t(ma: float, sa: float, na: int, mb: float, sb: float, nb: int) -> dict:
    """Welch t-тест для средних + 95% ДИ разности (Стьюдента, не z)."""
    va, vb = sa * sa / na, sb * sb / nb
    diff = mb - ma
    se = math.sqrt(va + vb)
    t = diff / se
    df = (va + vb) ** 2 / (va * va / (na - 1) + vb * vb / (nb - 1))
    p = betai(df / 2.0, 0.5, df / (df + t * t))
    tcrit = student_t_inv_975(df)
    return {
        "diff": diff,
        "t": t,
        "df": df,
        "pValue": p,
        "ciLo": diff - tcrit * se,
        "ciHi": diff + tcrit * se,
    }


def student_t_cdf(t: float, df: float) -> float:
    x = df / (df + t * t)
    half = 0.5 * betai(df / 2.0, 0.5, x)
    return 1.0 - half if t > 0 else half


def student_t_inv_975(df: float) -> float:
    lo, hi = 0.0, 200.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if student_t_cdf(mid, df) < 0.975:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def chi2_sf(x: float, df: int) -> float:
    """P(X > x) для хи-квадрат."""
    return gammq(df / 2.0, x / 2.0)


def sample_size_prop(baseline: float, mde: float, power: float = 0.8, alpha: float = 0.05) -> int:
    """Размер выборки на вариант для относительного MDE."""
    p1 = baseline
    p2 = baseline * (1.0 + mde)
    z_a, z_b = norm_inv(1 - alpha / 2), norm_inv(power)
    pbar = (p1 + p2) / 2
    num = (z_a * math.sqrt(2 * pbar * (1 - pbar)) + z_b * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    return math.ceil(num / (p2 - p1) ** 2)


# ---------------------------------------------------------------- вывод


def show(label: str, got: float) -> None:
    print(f"  {label:<28} {got!r}")


if __name__ == "__main__":
    print("=== нормальное распределение ===")
    show("normCdf(1.959963985)", norm_cdf(1.959963985))
    show("normCdf(-2.5)", norm_cdf(-2.5))
    show("normInv(0.975)", norm_inv(0.975))
    show("normInv(0.8)", norm_inv(0.8))
    show("normInv(0.995)", norm_inv(0.995))

    print("=== z-тест для долей ===")
    r = prop_z_test(1000, 10000, 1150, 10000)
    for k, v in r.items():
        show(k, v)

    print("=== z-тест: нулевая разница ===")
    r = prop_z_test(1000, 10000, 1002, 10000)
    for k, v in r.items():
        show(k, v)

    print("=== Welch t-тест ===")
    r = welch_t(102.4, 88.0, 10000, 108.1, 91.0, 10000)
    for k, v in r.items():
        show(k, v)

    print("=== t-квантиль ===")
    show("student_t_inv_975(10)", student_t_inv_975(10))
    show("student_t_inv_975(1000)", student_t_inv_975(1000))

    print("=== хи-квадрат ===")
    show("chi2_sf(3.841458821, 1)", chi2_sf(3.841458821, 1))
    show("chi2_sf(10.0, 4)", chi2_sf(10.0, 4))
    show("chi2_sf(90.0, 1)", chi2_sf(90.0, 1))

    print("=== размер выборки ===")
    show("baseline .05 mde .10", sample_size_prop(0.05, 0.10))
    show("baseline .05 mde .05", sample_size_prop(0.05, 0.05))
    show("baseline .20 mde .20", sample_size_prop(0.20, 0.20))

    print("=== бета-функция (для самопроверки betai) ===")
    show("betai(0.5, 0.5, 0.5)", betai(0.5, 0.5, 0.5))
    show("betai(2, 3, 0.4)", betai(2, 3, 0.4))