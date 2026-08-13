//! Transparent, deterministic health-score computation.
//!
//! The score is **never arbitrary**: every deduction is tied to a specific
//! `DiagnosticResult` and surfaced in the breakdown so the user can click
//! through to the underlying issue. Scoring rules (per `DeductionRule`):
//!
//! - a `Critical` issue costs 5 points in its category
//! - a `Warning` costs 3 points
//! - an `Info` costs 1 point
//!
//! Each category score is clamped to `[0, 100]`. The overall score is the
//! integer average of all category scores that actually had findings, falling
//! back to 100 when there are none. The overall severity is the worst issue's
//! severity (`Critical` > `Warning` > `Info`).

use std::collections::BTreeMap;

use super::{Deduction, DiagnosticCategory, DiagnosticResult, HealthReport, IssueCounts, ScoreBreakdown, Severity};

/// Points subtracted per severity level within a category.
const CRITICAL_PENALTY: u8 = 5;
const WARNING_PENALTY: u8 = 3;
const INFO_PENALTY: u8 = 1;

/// Penalty for a single issue based on its severity.
pub fn penalty_for(severity: Severity) -> u8 {
    match severity {
        Severity::Critical => CRITICAL_PENALTY,
        Severity::Warning => WARNING_PENALTY,
        Severity::Info => INFO_PENALTY,
    }
}

/// Compute a category score from a list of accumulated penalties (clamped 0–100).
pub fn category_score(penalties: u8) -> u8 {
    100u8.saturating_sub(penalties)
}

/// Roll up a flat list of diagnostics into a full `HealthReport`.
///
/// Pure: no I/O, no randomness. Same input always yields the same score, which
/// keeps the UI honest and makes this straightforward to unit-test.
pub fn build_health_report(results: Vec<DiagnosticResult>) -> HealthReport {
    let mut counts = IssueCounts::default();
    for r in &results {
        match r.severity {
            Severity::Critical => counts.critical += 1,
            Severity::Warning => counts.warning += 1,
            Severity::Info => counts.info += 1,
        }
    }

    // Group deductions by category.
    let mut by_category: BTreeMap<DiagnosticCategory, Vec<(DiagnosticResult, u8)>> = BTreeMap::new();
    for r in &results {
        let pen = penalty_for(r.severity);
        by_category.entry(r.category).or_default().push((r.clone(), pen));
    }

    let mut breakdown: Vec<ScoreBreakdown> = Vec::new();
    for (cat, items) in &by_category {
        let total_penalty: u16 = items.iter().map(|(_, p)| *p as u16).sum();
        let total_penalty = total_penalty.min(u16::from(u8::MAX)) as u8;
        let deductions: Vec<Deduction> = items
            .iter()
            .map(|(r, p)| Deduction {
                points: *p,
                reason: r.title.clone(),
                diagnostic_id: r.id.clone(),
            })
            .collect();
        breakdown.push(ScoreBreakdown {
            category: *cat,
            score: category_score(total_penalty),
            deductions,
        });
    }

    // Overall = average of category scores that appeared; 100 if no categories.
    let overall: u16 = if breakdown.is_empty() {
        100
    } else {
        let sum: u16 = breakdown.iter().map(|b| b.score as u16).sum();
        (sum / breakdown.len() as u16).min(100)
    };
    let overall = overall.min(100) as u8;

    let severity = if counts.critical > 0 {
        Severity::Critical
    } else if counts.warning > 0 {
        Severity::Warning
    } else {
        Severity::Info
    };

    HealthReport {
        score: overall,
        severity,
        breakdown,
        issue_counts: counts,
        results,
    }
}

// ───────────────────────── Tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn diag(id: &str, cat: DiagnosticCategory, sev: Severity) -> DiagnosticResult {
        DiagnosticResult {
            id: id.to_string(),
            category: cat,
            severity: sev,
            title: id.to_string(),
            description: String::new(),
            affected_objects: vec![],
            recommendation: None,
            can_auto_repair: false,
            repair_action: None,
            details: HashMap::new(),
        }
    }

    #[test]
    fn empty_results_are_perfect() {
        let report = build_health_report(vec![]);
        assert_eq!(report.score, 100);
        assert_eq!(report.severity, Severity::Info);
        assert!(report.breakdown.is_empty());
        assert_eq!(report.issue_counts.critical, 0);
    }

    #[test]
    fn penalty_mapping() {
        assert_eq!(penalty_for(Severity::Critical), 5);
        assert_eq!(penalty_for(Severity::Warning), 3);
        assert_eq!(penalty_for(Severity::Info), 1);
    }

    #[test]
    fn category_score_clamps_at_zero() {
        assert_eq!(category_score(0), 100);
        assert_eq!(category_score(3), 97);
        assert_eq!(category_score(200), 0); // overflow-safe clamp
    }

    #[test]
    fn critical_dominates_severity() {
        let report = build_health_report(vec![
            diag("a", DiagnosticCategory::Tables, Severity::Warning),
            diag("b", DiagnosticCategory::Indexes, Severity::Critical),
            diag("c", DiagnosticCategory::Indexes, Severity::Info),
        ]);
        assert_eq!(report.severity, Severity::Critical);
        assert_eq!(report.issue_counts.critical, 1);
        assert_eq!(report.issue_counts.warning, 1);
        assert_eq!(report.issue_counts.info, 1);
    }

    #[test]
    fn score_averages_categories() {
        // Tables: -3 → 97. Indexes: -5 -1 → 94. Avg(97,94) = 95.
        let report = build_health_report(vec![
            diag("a", DiagnosticCategory::Tables, Severity::Warning),
            diag("b", DiagnosticCategory::Indexes, Severity::Critical),
            diag("c", DiagnosticCategory::Indexes, Severity::Info),
        ]);
        assert_eq!(report.score, 95);
        // Two category entries.
        assert_eq!(report.breakdown.len(), 2);
        let tables = report.breakdown.iter().find(|b| b.category == DiagnosticCategory::Tables).unwrap();
        assert_eq!(tables.score, 97);
        let indexes = report.breakdown.iter().find(|b| b.category == DiagnosticCategory::Indexes).unwrap();
        assert_eq!(indexes.score, 94);
        // Each deduction carries a reason + id.
        assert!(indexes.deductions.iter().any(|d| d.points == 5 && d.reason == "b"));
    }

    #[test]
    fn only_infos_yields_info_severity_high_score() {
        let report = build_health_report(vec![
            diag("a", DiagnosticCategory::Maintenance, Severity::Info),
            diag("b", DiagnosticCategory::Maintenance, Severity::Info),
        ]);
        assert_eq!(report.severity, Severity::Info);
        assert_eq!(report.score, 98); // -1 -1 = 2 → 98
    }
}
