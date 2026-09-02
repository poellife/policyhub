# Poel Life — Worked Examples (Rubric v2.0)

## EXAMPLE A — Dominant-condition case (individualized review)

### Extracted findings (de-identified)
- Male, age 81. Oncology: Gleason 6 prostate cancer → prostatectomy 2002 → biochemical recurrence → PSMA-PET nodal metastases (distant/M1) → relugolix + darolutamide (11/2024) → PSA 0.24 (excellent response). ECOG ~1. Active metastatic, hormone-sensitive.
- Renal: stage 3b CKD, Cr ~1.4 → ~2.1 (eGFR ~32–35), progressive.
- Cardiac: CAD no angina; EF 55% (preserved); mild carotid; PAD. Metabolic: borderline T2DM, A1c 6.2–6.5; class I obesity. BP controlled; LDL 67. Never-smoker; ~7 drinks/wk.

### Reasoning trace
1. **Baseline.** 81M SSA 2023 ≈ 7.97 yr + 2.6 uplift = 10.6 yr.
2. **Dominant check.** Active metastatic malignancy → R6 → individualized. (Progressive CKD 3b scored as burden, not a separate dominant trigger.)
3. **Type-aware cancer anchor.** Prostate = treatable; nodal mets = distant → base 5.5 × ECOG 1 (×1.1) × responding (×1.5) ≈ 9.1 yr absolute ceiling. At 81 the multiplicative factor governs: metastatic factor (0.42 + 0.08 responding = 0.50) × 10.6 ≈ 5.3 yr, then competing comorbidity pulls the factor to ≈ 0.42 → ≈ 4.4 yr.
4. **Estimate.** Central ≈ 4.2 years (≈ age 85), range ~3–6 years. Lower-confidence category (active metastatic cancer).

### Output `le` block
- method: "Rubric v2.0: SSA 2023 baseline + 2.6-yr uplift, dominant-condition routing with the type-aware cancer anchor. Epidemiological approximation, not a prediction."
- baseline: "81M SSA 2023 ~7.97 yr + 2.6 uplift → baseline ≈ 10.6 yr."
- dominant: "Rule R6 — active metastatic prostate cancer → individualized review. Prostate is a treatable-tier tumour (nodal/distant anchor ~5.5 × ECOG × response ≈ 9 yr ceiling), but at 81 the multiplicative factor with competing comorbidity governs below that ceiling."
- factors: [Metastatic prostate cancer (active) | Lowers | Major | Node-only, hormone-sensitive, deep PSA response, ECOG 1], [Progressive stage 3b CKD | Lowers | Major | Cr 1.4→2.1], [Diffuse vascular disease | Lowers | Moderate | CAD + PAD + carotid; compensated], [Preserved EF 55% | Supports | Moderate | No heart failure], [Excellent risk-factor control | Supports | Moderate | BP, LDL 67, A1c 6.2], [Never-smoker; engaged care | Supports | Modest | Independent]
- estimate: "Estimated remaining life expectancy: roughly 3–6 years (to ~age 84–87), central ~4 years."
- caveat: "Individualized estimate; active metastatic cancer is a lower-confidence category — treat as indicative and weight the records review."

## EXAMPLE B — Additive case (no dominant condition)

### Extracted findings
- Male, ~69. Asymptomatic CAD (CAC 471); 4.2 cm ascending aneurysm; LDL 77; HTN not fully controlled. Heavy alcohol ~21 drinks/wk; very physically active; never-smoker. A1c 4.7; BMI ~29. No malignancy, no CKD, no dominant trigger.

### Reasoning trace
1. **Baseline.** 69M SSA 2023 ~15.34 yr + 2.6 → 17.9 yr.
2. **Dominant check.** None → additive.
3. **Debits (one per system):** treated high-CAC CAD −2 · uncontrolled HTN −1.8 · heavy alcohol −2 · overweight −0.3. (Aneurysm <5 cm dropped under R2.) Total ≈ −6.1 (<8, no smoothing).
4. **Retention ×0.75** → applied debit ≈ −4.6.
5. **Credits:** very active +0.5, never-smoker +0.5, strong function +1.5 → +2.5 raw, cap +2.5.
6. **Net.** 17.9 − 4.6 + 2.5 ≈ 15.9 yr (≈ age 85), range ~14–18. Function floor (baseline ×0.45 ≈ 8.1) does not bind.

## Pitfalls
- Run the dominant-condition check before any additive math.
- Active cancer is type-aware: tier, stage, ECOG; read the anchor; scale; cap at baseline.
- Dementia is stage-graded. One debit per system. Keep 75% of the debit burden. Credits capped and never offset a dominant condition.
- ILD is its own respiratory finding; albuminuria is an independent renal driver.
- Populate disease-specific modules when records allow. State the accuracy note. De-identify everything.
