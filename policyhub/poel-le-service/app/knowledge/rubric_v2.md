# Poel Life — LE Estimation Rubric v2.0 (records-based, calibrated)

**Status:** Authoritative scoring rubric. This is the same engine that powers the online self-report screening tool, but written for **records-based review**, where you have exact labs, staging, performance status, imaging and trend data — so use full precision and populate the disease-specific modules (§6) rather than banded approximations.

**Provenance / calibration.** The magnitudes, the cohort uplift, the debit-retention factor, the cancer anchors and the dementia grading were fitted and back-tested against **173 real LSI / AVS / 21st Services underwriter certificates** plus **23 out-of-sample certificates**. On the 173-case set the engine sits at mean error ≈ 0 years, average absolute miss ≈ 2.0 years, ~79% within 3 years. Out-of-sample average miss ≈ 1.7 years. These are Poel Life conventions tuned to underwriter experience, not raw literature values.

---

## 1. Baseline

Start from the **SSA 2023 period life table** (2026 Trustees Report), exact age and sex, remaining years. Then add the **select-cohort uplift of +2.6 years**.

Anchor sanity checks (male / female remaining years, pre-uplift): 60 → 21.8 / 24.7; 65 → 18.0 / 20.6; 70 → 14.7 / 16.8; 75 → 11.4 / 13.1; 80 → 8.5 / 9.8; 85 → 6.0 / 7.0; 90 → 4.1 / 4.8; 95 → 2.9 / 3.3. Interpolate for intermediate ages. Add +2.6 to each.

---

## 2. Combination rules

- **R1** — work in years remaining.
- **R2 — one debit per disease system.** Within a system keep only the single largest applicable debit.
- **R3 — comorbidity smoothing.** If summed debits exceed 8 years, apply the excess at 0.85 (`8 + (total − 8) × 0.85`).
- **Debit retention (0.75).** Multiply the smoothed debit total by **0.75** before subtracting from baseline.
- **R4 — credit cap.** Total credits capped at **+1.5 years** (**+2.5** when strongly functional — §5). Net remaining additionally guarded not to exceed baseline + 5.
- **R5 — age attenuation.** Ranged debits use the **midpoint**, applied in full under 75 and ×0.71 at 75+. Never attenuate a dominant-condition anchor.
- **R6 — dominant conditions bypass additive math** and route to §3.
- **R7 — floor.** Net remaining floored at **current age + 1 year**. For a **strongly-functional** life the floor rises to **baseline × 0.35** (regularly active) or **× 0.45** (very active).
- **R8 — unassessed.** Anything not documented is "unassessed," never assumed normal; widen the range and lower confidence.

**Order of operations:** baseline → dominant check (§3) → if none, additive debits (one per system, §4) → smoothing → ×0.75 retention → subtract → add capped credits (§5) → apply guards/floor → range.

---

## 3. Dominant conditions & absolute anchors

If any of the following is present, bypass additive scoring, show the trigger explicitly, and use the stated absolute anchor (or fraction of baseline). Other comorbidities pull the anchor down modestly (multiply by up to ~0.92 for several coexisting debits). Credits cannot offset a dominant condition. Always state that a records-based individualized review governs.

### 3a. Active malignancy — TYPE-aware absolute anchor

Compute an **absolute remaining-years anchor**, then cap at baseline. Do **not** express metastatic cancer as a fraction of a young person's large baseline.

**Step 1 — classify the cancer type into a tier:**
- **Treatable**: breast, prostate, thyroid, renal cell / kidney, testicular, follicular / marginal-zone / CLL, well-differentiated (grade 1) neuroendocrine / carcinoid, papillary, Hodgkin lymphoma.
- **Aggressive**: pancreatic, lung (esp. small-cell), gastric, esophageal, ovarian, glioblastoma / high-grade brain, cholangiocarcinoma / biliary, mesothelioma, hepatocellular.
- **Intermediate** (default): colon / colorectal, sarcoma, bladder, head & neck, cervical, uterine / endometrial, melanoma, multiple myeloma, generic or non-Hodgkin lymphoma, unspecified.

**Step 2 — base anchor (years) by tier × stage/extent:**

| Tier | Distant / metastatic | Regional | Localized | Stage unknown (non-metastatic) |
|---|---|---|---|---|
| Treatable | 5.5 | 6.5 | 8.5 | 6.5 |
| Intermediate | 2.8 | 4.5 | 7.0 | 5.0 |
| Aggressive | 1.6 | 3.2 | 5.5 | 3.5 |

**Step 3 — scale the anchor:**
- **ECOG:** ×1.4 (0), ×1.1 (1), ×0.8 (2), ×0.5 (3), ×0.3 (4).
- **Treatment response:** ×1.5 if responding / stable / durable partial response.
- **Recency:** ×0.85 if <6 months since diagnosis and not yet responding.
- **Cap at baseline.** Floor at ~0.5 yr.

For older lives the multiplicative factor with competing comorbidity usually governs below the ceiling (metastatic factor ≈ 0.42 of baseline, +0.08 if responding, then × ~0.92 for competing comorbidity); the absolute anchor is the ceiling that matters for *younger* metastatic cases. Cross-check against SEER conditional survival / a tumour nomogram (§6) when records permit and take the more conservative. Favourable metastatic subtypes (e.g. HR+ metastatic breast on modern therapy) can outlive the treatable anchor — say so.

### 3b. Renal — ESRD / dialysis
eGFR <15 or on dialysis: **baseline × 0.40** (× ~0.34 if also ADL-dependent). Advanced CKD (eGFR 15–29) **rapidly progressing**: baseline × 0.55.

### 3c. Heart failure — EF <30% (HFrEF, severe)
**Baseline × 0.45**. Run the **Seattle Heart Failure Model** (§6) where inputs exist; take the more conservative.

### 3d. Dementia — stage-graded (fraction of baseline)
- **MCI / very mild, fully independent** → not dominant; additive neurologic debit −1 to −2.5.
- **Mild / early, independent in basic self-care** → **× 0.68**.
- **Moderate, needs help with everyday activities** → **× 0.48**.
- **Severe / advanced, dependent for daily care** → **× 0.30**.
- Stage undocumented → default moderate (× 0.48). CFS ≥7 or full ADL dependence floors toward severe.

### 3e. Other dominant triggers
Decompensated cirrhosis (ascites / variceal bleed / encephalopathy) → baseline × 0.35 (use **MELD 3.0**); advanced Parkinson's → × 0.50; aortic aneurysm ≥5.0 cm → × 0.60; active alcohol-use disorder → × 0.55.

---

## 4. Additive debits (one largest per system; ranges are midpoint, age-attenuated per R5)

**Cardiovascular** — HFrEF EF 30–39% −4 to −8 · HFpEF / unspecified-EF HF −2 to −5 · symptomatic CAD / MI / stent / bypass −2 to −5 · treated / high-calcium asymptomatic CAD −1 to −3 (−1 to −4 if <65) · significant valve disease −1 to −4 · PAD −2 to −4 · atrial fibrillation −0.5 to −1.5 · aortic aneurysm <5.0 cm −0.5 to −1.

**Blood pressure** — uncontrolled hypertension −1 to −2.5 (~0 once controlled).

**Metabolic** — Type 2 diabetes, age-banded: <50 ≈ −6, 50s ≈ −5, 60s ≈ −3, 70s ≈ −1.5, 80+ ≈ −0.5; **add −2 to −4 (age-attenuated)** for A1c ≥9, insulin use, or end-organ damage. Obesity: overweight (BMI 27.5–30) 0 to −0.5 · class I −0.5 to −1 · class II −1 to −2 · class III −3 to −8 (age-attenuated). Diabetes vs obesity: keep the larger.

**Renal** — **albuminuria / proteinuria −1.5 to −3 even with preserved eGFR**, compounds with reduced eGFR. eGFR 45–59 (G3a) −1 to −2 (+~2 with proteinuria) · 30–44 (G3b) −3 to −6 (+~1.5 proteinuria; more if progressing) · 15–29 (G4, non-progressive) −6 to −12.

**Respiratory** — COPD mild −1 to −2 / moderate −2 to −4 / severe or home O2 −4 to −8. **Interstitial lung disease / pulmonary fibrosis (separate from COPD): on oxygen −4 to −7; not on oxygen −2.5 to −5.** Controlled asthma 0.

**Hepatic** — NAFLD without fibrosis 0 to −0.5 · advanced fibrosis (F3) −2 to −4 · compensated cirrhosis −3 to −6.

**Oncology history** (time-banded; **add the advanced-stage modifier** if stage III/IV at diagnosis) — disease-free <2 yr −4.5 (−6.5 advanced) · 2–5 yr −2 (−4.5 advanced) · >5 yr −0.75 (−1.75 advanced) · cured early-stage remote 0.

**Neurologic** — prior stroke / TIA −2 to −4 · Parkinson's (not advanced) −1.5 to −4 · MCI (independent) −1 to −2.5.

**Smoking** (own system; age-banded, not further attenuated) — current <60 ≈ −8.5 / 60s ≈ −4.5 / 70+ ≈ −2.5 · former quit <5 yr or heavy pack-years −2 / 5–15 yr −1 / >15 yr −0.25.

**Alcohol** — heavy (men >14, women >7 drinks/wk) −1 to −3 · very heavy (>2× threshold) −3 to −6.

**Functional / frailty** — dependence in ≥3 ADLs or mostly chair/bed-bound −4 to −8 · needs help with daily activities / frailty / repeated falls −2 to −5 · recurrent falls (2+/yr) −1 to −2.5 · one fall −0.3 to −1.

**Recent utilization / constitutional** — ≥3 admissions/yr −2 to −4 / two −1 to −2.5 / one −0.5 to −1 · unintentional weight loss −1 to −2.5 · recently widowed −0.5 to −1.5.

---

## 5. Credits (capped +1.5, or +2.5 when strongly functional)

Regular physical activity +0.5 · never-smoker +0.5 · regular care with controlled risk factors +0.5 · favorable family longevity +0.25 · healthy weight (BMI 18.5–25) +0.25 · married / partnered +0.5.

**Strong physical function / independence:** independent in all basic ADLs, regularly (or very) active, no frailty markers, no recurrent falls, no unintentional weight loss — add **+1.0 (regularly active)** or **+1.5 (very active)**, raise the credit cap to **+2.5**, and raise the R7 floor.

---

## 6. Dual-engine framing & disease-specific modules

**Engine 1 — general-population triangulation** (shown side-by-side, never summed): Charlson comorbidity index; Lee-style 4-year and Schonberg-style 5-year mortality screens; frailty by Clinical Frailty Scale / Fried phenotype.

**Engine 2 — disease-specific modules** (use whenever the inputs are in the records):
- **Cancer:** SEER conditional survival / tumour-specific nomogram, informed by stage + ECOG.
- **Heart failure:** Seattle Heart Failure Model (EF, NYHA, SBP, sodium, hemoglobin, meds, device).
- **Cirrhosis:** MELD 3.0 (bilirubin, INR, creatinine, sodium, albumin, sex).
- **COPD:** BODE index (BMI, FEV1 %, 6-minute walk, mMRC) — COPD only, never ILD.
- **Dialysis/ESKD, dementia/frailty:** stage-/CFS-graded per §3.

Integrated estimate = min(Engine 1 general estimate, any triggered Engine-2 module). State which engine governs.

---

## 7. Accuracy profile (state this in the report's LE section)

Most reliable: clearly-healthy or clearly-frail lives; common chronic disease (HF, COPD, CKD/dialysis, diabetes) in older adults; a single well-defined dominant condition. Least reliable — widen the range and lean on records: active cancer (favourable metastatic subtypes and relapsing/remission hematologic cancers especially); highly-functional-but-comorbid or impaired-but-stable lives; conditions with no dedicated factor (ALS / neuromuscular disease, sleep apnea, indolent myeloproliferative disorders); the very young or very old.

---

## 8. Sources

SSA 2023 period life table. CKD-PC Lancet 2010 / Turin 2015 (renal). ERFC Lancet Diab. Endocrinol. 2023, NEJM 2011; JAMA 2015 (diabetes). Global BMI Mortality Collaboration Lancet 2016; PSC Lancet 2009 (obesity). Jha NEJM 2013; NEJM Evidence 2024 (smoking). GWTG-HF / MAGGIC / Seattle HF (heart failure). ABI Collaboration JAMA 2008 (PAD). Dulai Hepatology 2017 / MELD 3.0 (liver). SEER conditional survival (cancer); Rountree 2012 / Todd BMJ Open 2013 (dementia); npj Parkinson's 2022 (PD). Caps, smoothing, retention, uplift and age multipliers are Poel Life conventions calibrated to underwriter experience.
