//! The default routing strategy.

use async_trait::async_trait;

use super::router::RoutingCandidate;
use super::strategy::{RoutingAttempt, RoutingContext, RoutingStrategy};
use crate::error::BoxError;

/// Selects the healthiest candidate not yet tried since the last success (`FallbackStrategy`):
/// the fewest failures, ties broken by declaration order. A success clears that candidate's
/// failure count.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct FallbackStrategy;

impl FallbackStrategy {
    /// The strategy.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

fn attempts_since_success(attempts: &[RoutingAttempt]) -> &[RoutingAttempt] {
    match attempts.iter().rposition(|attempt| attempt.exception.is_none()) {
        Some(index) => &attempts[index + 1..],
        None => attempts,
    }
}

#[async_trait]
impl RoutingStrategy for FallbackStrategy {
    async fn select(&self, context: &RoutingContext) -> Result<Option<RoutingCandidate>, BoxError> {
        let mut failures: Vec<(&RoutingCandidate, usize)> = Vec::new();
        for attempt in &context.attempts {
            let position = failures
                .iter()
                .position(|(candidate, _)| *candidate == &attempt.candidate);
            match (attempt.exception.is_some(), position) {
                (false, Some(index)) => {
                    failures.remove(index);
                }
                (true, Some(index)) => failures[index].1 += 1,
                (true, None) => failures.push((&attempt.candidate, 1)),
                (false, None) => {}
            }
        }
        let failures_of = |candidate: &RoutingCandidate| {
            failures
                .iter()
                .find(|(failed, _)| *failed == candidate)
                .map_or(0, |(_, count)| *count)
        };
        let tried = attempts_since_success(&context.attempts);
        let best = context
            .candidates
            .iter()
            .filter(|candidate| !tried.iter().any(|attempt| &attempt.candidate == *candidate))
            .fold(None, |best: Option<&RoutingCandidate>, candidate| match best {
                Some(best) if failures_of(candidate) >= failures_of(best) => Some(best),
                _ => Some(candidate),
            });
        Ok(best.cloned())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::models::routing::RoutingFailure;
    use crate::testing::MockModel;

    fn candidates(count: usize) -> Vec<RoutingCandidate> {
        (0..count)
            .map(|_| RoutingCandidate::from(Arc::new(MockModel::new()) as Arc<dyn crate::models::Model>))
            .collect()
    }

    fn failed(candidate: &RoutingCandidate) -> RoutingAttempt {
        RoutingAttempt::failure(candidate.clone(), RoutingFailure::new("Error", "down"))
    }

    fn succeeded(candidate: &RoutingCandidate) -> RoutingAttempt {
        RoutingAttempt::success(candidate.clone())
    }

    async fn select(candidates: &[RoutingCandidate], attempts: Vec<RoutingAttempt>) -> Option<RoutingCandidate> {
        let context = RoutingContext::new(candidates.to_vec()).with_attempts(attempts);
        FallbackStrategy.select(&context).await.unwrap()
    }

    #[tokio::test]
    async fn uses_declaration_order_before_any_attempt() {
        let all = candidates(2);
        assert_eq!(select(&all, vec![]).await, Some(all[0].clone()));
    }

    #[tokio::test]
    async fn advances_through_each_candidate_once_in_a_failure_round() {
        let all = candidates(2);
        assert_eq!(select(&all, vec![failed(&all[0])]).await, Some(all[1].clone()));
        assert_eq!(select(&all, vec![failed(&all[0]), failed(&all[1])]).await, None);
    }

    #[tokio::test]
    async fn rearms_after_success_while_retaining_other_candidates_failure_history() {
        let all = candidates(3);
        let attempts = vec![failed(&all[0]), succeeded(&all[1]), failed(&all[1])];
        assert_eq!(select(&all, attempts).await, Some(all[2].clone()));
    }

    #[tokio::test]
    async fn clears_a_successful_candidate_s_own_accumulated_failure_count() {
        let all = candidates(3);
        let attempts = vec![
            failed(&all[0]),
            failed(&all[0]),
            failed(&all[1]),
            succeeded(&all[0]),
            failed(&all[2]),
        ];
        assert_eq!(select(&all, attempts).await, Some(all[0].clone()));
    }

    #[tokio::test]
    async fn rearms_the_other_candidate_after_a_fallback_succeeds_and_later_fails() {
        let all = candidates(2);
        let attempts = vec![failed(&all[0]), succeeded(&all[1]), failed(&all[1])];
        assert_eq!(select(&all, attempts).await, Some(all[0].clone()));
    }
}
