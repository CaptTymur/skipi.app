pub mod agency_mailing;
pub mod ai;
pub mod assistant;
pub mod cv_commands;
pub mod documents;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod email;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "email_mobile.rs"]
pub mod email;
pub mod jobs;
pub mod mail_intent;
pub mod messaging;
pub mod packages;
pub mod profile;
pub mod review;
pub mod vault;
pub mod work_history;
