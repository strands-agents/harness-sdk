use super::*;

fn parsed(value: f64, is_share: bool) -> Option<ParsedCondition> {
    Some(ParsedCondition { value, is_share })
}

#[test]
fn accepts_condition_values() {
    let cases: [(ConditionName, ConditionValue, Option<ParsedCondition>); 7] = [
        (ConditionName::ContextUtilization, "70%".into(), parsed(70.0, true)),
        (
            ConditionName::ContextUtilization,
            50_000.into(),
            parsed(50_000.0, false),
        ),
        (ConditionName::ContextUtilization, 1000.into(), parsed(1000.0, false)),
        (ConditionName::BlockThreshold, 2500.into(), parsed(2500.0, false)),
        (ConditionName::BlockThreshold, "5%".into(), parsed(5.0, true)),
        (ConditionName::PreserveRecent, 4.into(), parsed(4.0, false)),
        (ConditionName::PreserveRecent, "50%".into(), parsed(50.0, true)),
    ];
    for (name, raw, expected) in cases {
        assert_eq!(parse_condition(name, Some(&raw)).unwrap(), expected, "{name:?} {raw}");
    }
}

#[test]
fn rejects_condition_values() {
    let cases: [(ConditionName, ConditionValue, &str); 13] = [
        (ConditionName::ContextUtilization, 0.into(), "0"),
        (ConditionName::ContextUtilization, 0.5.into(), "0.5"),
        (ConditionName::ContextUtilization, 1.into(), "1"),
        (ConditionName::ContextUtilization, 1.5.into(), "1.5"),
        (ConditionName::ContextUtilization, "101%".into(), "\"101%\""),
        (ConditionName::ContextUtilization, "70".into(), "\"70\""),
        (ConditionName::BlockThreshold, (-1).into(), "-1"),
        (ConditionName::BlockThreshold, 0.into(), "0"),
        (ConditionName::BlockThreshold, 0.5.into(), "0.5"),
        (ConditionName::BlockThreshold, "100%".into(), "\"100%\""),
        (ConditionName::PreserveRecent, 0.5.into(), "0.5"),
        (ConditionName::PreserveRecent, 1.5.into(), "1.5"),
        (ConditionName::PreserveRecent, "100%".into(), "\"100%\""),
    ];
    for (name, raw, shown) in cases {
        let error = parse_condition(name, Some(&raw)).unwrap_err().to_string();
        assert!(
            error.contains(&format!("{}={shown} is invalid: expected ", name.as_str())),
            "{error}"
        );
    }
}

#[test]
fn rejects_and_suggests_a_percent_when_it_reads_as_one() {
    let utilization = "a \"N%\" string up to \"100%\" or a whole token count of at least 1000";
    let preserve = "a \"N%\" string below \"100%\" or a whole message count";
    let cases: [(ConditionName, ConditionValue, &str, &str, &str); 5] = [
        (
            ConditionName::ContextUtilization,
            80.into(),
            "80",
            utilization,
            "; for 80%, write \"80%\"",
        ),
        (
            ConditionName::ContextUtilization,
            0.8.into(),
            "0.8",
            utilization,
            "; for 80%, write \"80%\"",
        ),
        (
            ConditionName::ContextUtilization,
            1.into(),
            "1",
            utilization,
            "; for 100%, write \"100%\"",
        ),
        (ConditionName::ContextUtilization, 999.into(), "999", utilization, ""),
        (
            ConditionName::PreserveRecent,
            0.07.into(),
            "0.07",
            preserve,
            "; for 7%, write \"7%\"",
        ),
    ];
    for (name, raw, shown, expected, hint) in cases {
        let error = parse_condition(name, Some(&raw)).unwrap_err().to_string();
        assert_eq!(
            error,
            format!("{}={shown} is invalid: expected {expected}{hint}", name.as_str())
        );
    }
}

#[test]
fn without_preserved_leaves_the_older_matches() {
    let cases: [(ConditionValue, usize, usize); 5] = [
        (3.into(), 10, 7),
        ("70%".into(), 10, 3),
        ("50%".into(), 3, 1),
        ("99%".into(), 10, 0),
        // A share that divides exactly keeps exactly that many, with no rounding up from float error.
        ("7%".into(), 100, 93),
    ];
    for (preserve, count, left) in cases {
        let conditions = ResolvedConditions::new(&OffloadConditions {
            preserve_recent: Some(preserve.clone()),
            ..OffloadConditions::default()
        })
        .unwrap();
        let matches: Vec<usize> = (0..count).collect();
        assert_eq!(
            conditions.without_preserved(&matches),
            (0..left).collect::<Vec<_>>(),
            "{preserve} of {count}"
        );
    }
}
