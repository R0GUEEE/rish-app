import UIKit
import UserNotifications
import BackgroundTasks
import ActivityKit
import React

struct TaskPreferences: Codable {
  var completed = false
  var failed = false
  var attention = false
  var liveActivity = true
  var background = false
  var muted: [String] = []
}

@MainActor
final class TaskExperience: NSObject, UNUserNotificationCenterDelegate {
  static let shared = TaskExperience()
  static var prefix: String { (Bundle.main.bundleIdentifier ?? "tech.zseven.rish") + ".task" }
  static let preferenceKey = "rish.task.preferences.v1"
  private var preferences = TaskPreferences()
  private var current: [String: String]?
  private var startedAt = Date()
  private var visibleConversation: String?
  private var language: String?
  private var notified: Set<String> = []
  private var activity: Any?
  private var backgroundTask: Any?
  private var backgroundIdentifier: String?
  private var completedBackgroundIdentifiers: [String] = []
  private var registrationCount = 0
  private var backgroundAdmission = "notRequested"
  private var supportsBackground: Bool {
    if #available(iOS 26.0, *) { return registrationCount < 256 }
    return false
  }
  private var lease: UIBackgroundTaskIdentifier = .invalid
  private var actions: [[String: String]] = []
  var emit: (([String: String]) -> Void)?

  func configure() {
    if let data = UserDefaults.standard.data(forKey: Self.preferenceKey),
       let saved = try? JSONDecoder().decode(TaskPreferences.self, from: data) { preferences = saved }
    UNUserNotificationCenter.current().delegate = self
    // A display checkpoint never authorizes execution after launch.
    if let old = UserDefaults.standard.string(forKey: "rish.task.background.id") {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: old)
      UserDefaults.standard.removeObject(forKey: "rish.task.background.id")
    }
    if #available(iOS 16.2, *) {
      Task { for old in Activity<RishTaskAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) } }
    }
    NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in self.enterBackground() }
    }
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
      Task { @MainActor in
        if self.lease != .invalid { UIApplication.shared.endBackgroundTask(self.lease); self.lease = .invalid }
      }
    }
  }

  private var chinese: Bool { (language ?? Locale.preferredLanguages.first ?? "en").hasPrefix("zh") }
  private func text(_ en: String, _ zh: String) -> String { chinese ? zh : en }
  private func stage(_ phase: String) -> String {
    switch phase {
    case "preparing", "starting": return text("Preparing", "正在准备")
    case "sending": return text("Waiting for model", "等待模型回复")
    case "approval_pending": return text("Needs your attention", "需要你处理")
    case "executing": return text("Running tools", "正在执行工具")
    case "recovering": return text("Checking saved state", "核对已保存状态")
    case "cancelling": return text("Stopping safely", "正在安全停止")
    case "finalizing": return text("Saving result", "正在保存结果")
    case "completed": return text("Task complete", "任务已完成")
    case "cancelled": return text("Task stopped", "任务已停止")
    default: return text("Return to Rish to continue", "返回 Rish 继续处理")
    }
  }

  func handle(_ input: String) async throws -> Any {
    guard input.utf8.count < 32768,
          let data = input.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          request["schema_version"] as? Int == 1, let op = request["op"] as? String else { throw invalid() }
    switch op {
    case "inspection":
      guard Bundle.main.bundleIdentifier?.hasPrefix("dev.zseven.rish.taskacceptance") == true else { throw invalid() }
      var activityActive = false
      if #available(iOS 16.2, *), let live = activity as? Activity<RishTaskAttributes> { activityActive = live.activityState == .active }
      return ["visibleConversation": visibleConversation ?? "", "running": current != nil,
        "phase": current?["phase"] ?? "idle", "interrupted": current?["interrupted"] == "true", "stopRequested": current?["stopRequested"] == "true",
        "liveActivityActive": activityActive, "backgroundAccepted": backgroundTask != nil, "backgroundAdmission": backgroundAdmission,
        "applicationActive": UIApplication.shared.applicationState == .active]
    case "settings": return await settings()
    case "preferences":
      guard let raw = request["preferences"] as? [String: Any] else { throw invalid() }
      let value = try JSONDecoder().decode(TaskPreferences.self, from: JSONSerialization.data(withJSONObject: raw))
      guard value.muted.count <= 500, value.muted.allSatisfy(validID) else { throw invalid() }
      preferences = value
      UserDefaults.standard.set(try JSONEncoder().encode(value), forKey: Self.preferenceKey)
      if !value.liveActivity { await endActivity() }
      if !value.background {
        finishBackground(success: false)
        if UIApplication.shared.applicationState != .active { enterBackground() }
      }
      return await settings()
    case "permission":
      _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
      return await settings()
    case "openSettings":
      if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
      return true
    case "visible":
      visibleConversation = request["conversationId"] as? String
      if let locale = request["locale"] as? String, ["zh-CN", "en-US"].contains(locale) { language = locale }
      return true
    case "drain": let result = actions; actions.removeAll(); return result
    case "begin":
      guard let run = request["runId"] as? String, validID(run),
            let conversation = request["conversationId"] as? String, validID(conversation) else { throw invalid() }
      if current?["runId"] == run { return true }
      await endActivity(); finishBackground(success: false)
      current = ["runId": run, "conversationId": conversation, "phase": "preparing"]
      startedAt = Date(); notified.removeAll(); backgroundAdmission = "notRequested"
      // Request only while a user-initiated operation owns the foreground.
      if preferences.background, UIApplication.shared.applicationState == .active, #available(iOS 26.0, *), supportsBackground {
        let identifier = Self.prefix + "." + UUID().uuidString
        let task = BGContinuedProcessingTaskRequest(identifier: identifier, title: "Rish", subtitle: stage("preparing"))
        task.strategy = .fail
        // Wildcards belong in Info.plist; registration requires the concrete
        // identifier. Handlers do not retain a run or resume work. Bound the
        // number of process-lifetime registrations to avoid accumulating them.
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
          Task { @MainActor in self.accept(task) }
        }
        registrationCount += 1
        if registered {
          do {
            backgroundIdentifier = identifier
            try BGTaskScheduler.shared.submit(task)
            backgroundAdmission = "submitted"
            UserDefaults.standard.set(identifier, forKey: "rish.task.background.id")
          } catch {
            backgroundIdentifier = nil
            backgroundAdmission = "unavailable"
          }
        } else { backgroundAdmission = "registrationRejected" }
      }
      if preferences.liveActivity, #available(iOS 16.2, *), ActivityAuthorizationInfo().areActivitiesEnabled {
        activity = try? Activity.request(attributes: RishTaskAttributes(conversationId: conversation, runId: run, startedAt: startedAt, locale: chinese ? "zh-CN" : "en-US"),
          content: ActivityContent(state: .init(stage: stage("preparing"), finished: false), staleDate: Date().addingTimeInterval(90)), pushType: nil)
      }
      if UIApplication.shared.applicationState != .active { enterBackground() }
      return true
    case "update":
      guard let phase = request["phase"] as? String,
            ["preparing", "persistence_pending", "starting", "sending", "approval_pending", "executing", "recovering", "cancelling", "finalizing", "retryable", "resume_available", "commit_pending", "blocked"].contains(phase) else { throw invalid() }
      guard current?["runId"] == request["runId"] as? String, current != nil else { return false }
      if phase != "approval_pending" { notified.remove("attention") }
      current?["phase"] = phase
      if #available(iOS 26.0, *), let task = backgroundTask as? BGContinuedProcessingTask {
        // Count actual stage transitions; never manufacture timed progress.
        task.progress.completedUnitCount += 1
        task.updateTitle("Rish", subtitle: stage(phase))
      }
      if #available(iOS 16.2, *), let live = activity as? Activity<RishTaskAttributes> {
        await live.update(ActivityContent(state: .init(stage: stage(phase), finished: false), staleDate: Date().addingTimeInterval(90)))
      }
      if phase == "approval_pending" { await notify("attention") }
      return true
    case "end":
      guard current?["runId"] == request["runId"] as? String, current != nil else { return false }
      let status = request["status"] as? String ?? "blocked"
      if status == "completed" { await notify("completed") }
      else if status != "cancelled" || current?["interrupted"] == "true" { await notify("failed") }
      await endActivity(); finishBackground(success: status == "completed")
      current = nil
      return true
    default: throw invalid()
    }
  }

  private func validID(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= 256 && !value.contains("\0") }
  private func invalid() -> NSError { NSError(domain: "RishTaskExperience", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid task request"]) }
  private func settings() async -> [String: Any] {
    let status = await UNUserNotificationCenter.current().notificationSettings()
    let authorization: String
    switch status.authorizationStatus {
    case .authorized, .provisional, .ephemeral: authorization = "authorized"
    case .denied: authorization = "denied"
    default: authorization = "notDetermined"
    }
    var live = false
    if #available(iOS 16.2, *) { live = ActivityAuthorizationInfo().areActivitiesEnabled }
    return ["available": true, "notifications": authorization, "liveActivitiesAvailable": live,
            "backgroundAvailable": supportsBackground, "backgroundAdmission": backgroundAdmission,
            "preferences": (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences))) ?? [:]]
  }

  private func notify(_ kind: String) async {
    guard let current else { return }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    let enabled = kind == "completed" ? preferences.completed : kind == "failed" ? preferences.failed : preferences.attention
    guard TaskAlertPolicy.allows(kind: kind, enabled: enabled,
      muted: preferences.muted.contains(current["conversationId"]!),
      foreground: UIApplication.shared.applicationState == .active,
      viewingConversation: visibleConversation == current["conversationId"],
      delivered: notified.contains(kind), sameRun: self.current?["runId"] == current["runId"]),
      [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus) else { return }
    let content = UNMutableNotificationContent()
    content.title = "Rish"
    content.body = kind == "completed" ? stage("completed") : kind == "attention" ? stage("approval_pending") : text("Task needs review", "任务需要检查")
    content.sound = .default
    content.threadIdentifier = current["conversationId"]!
    content.userInfo = ["conversationId": current["conversationId"]!, "runId": current["runId"]!]
    do {
      try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: current["runId"]! + "." + kind, content: content, trigger: nil))
      notified.insert(kind)
    } catch { /* Display delivery must not change durable task outcome. */ }
  }

  private func enterBackground() {
    guard let run = current?["runId"], backgroundTask == nil else { return }
    lease = UIApplication.shared.beginBackgroundTask(withName: "Rish task checkpoint") {
      Task { @MainActor in
        guard self.current?["runId"] == run else { return }
        self.requestCancel(runId: run); self.finishBackground(success: false)
      }
    }
    if lease == .invalid { requestCancel(runId: run) }
  }
  @available(iOS 26.0, *) private func accept(_ task: BGTask) {
    guard let task = task as? BGContinuedProcessingTask, task.identifier == backgroundIdentifier, current != nil else {
      task.setTaskCompleted(success: completedBackgroundIdentifiers.contains(task.identifier)); return
    }
    backgroundTask = task
    backgroundAdmission = "accepted"
    // An agent has no known total number of steps. Keep its progress
    // indeterminate instead of inventing a completion percentage.
    task.progress.totalUnitCount = -1
    task.progress.completedUnitCount = 0
    let ownerRun = current!["runId"]!
    let ownerIdentifier = task.identifier
    task.expirationHandler = { Task { @MainActor in
      guard self.current?["runId"] == ownerRun, self.backgroundIdentifier == ownerIdentifier else { return }
      self.requestCancel(runId: ownerRun)
      // Keep a short cleanup lease until the existing controller confirms its
      // durable cancellation. Never acknowledge completion before that flush.
      if self.lease == .invalid {
        self.lease = UIApplication.shared.beginBackgroundTask(withName: "Rish cancellation checkpoint") {
          Task { @MainActor in
            guard self.current?["runId"] == ownerRun else { return }
            self.finishBackground(success: false)
          }
        }
      }
      if self.lease == .invalid { self.finishBackground(success: false) }
    } }
    // The system continued-processing presentation already owns this task.
    Task {
      guard self.current?["runId"] == ownerRun else { return }
      await endActivity()
    }
  }
  private func finishBackground(success: Bool) {
    if #available(iOS 26.0, *), let task = backgroundTask as? BGContinuedProcessingTask {
      if success {
        let completed = max(1, task.progress.completedUnitCount)
        task.progress.totalUnitCount = completed; task.progress.completedUnitCount = completed
      }
      task.setTaskCompleted(success: success)
    }
    backgroundTask = nil
    if let id = backgroundIdentifier {
      if success { completedBackgroundIdentifiers = Array((completedBackgroundIdentifiers + [id]).suffix(32)) }
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id)
    }
    backgroundIdentifier = nil
    UserDefaults.standard.removeObject(forKey: "rish.task.background.id")
    if lease != .invalid { UIApplication.shared.endBackgroundTask(lease); lease = .invalid }
  }
  private func endActivity() async {
    let previous = activity
    activity = nil
    if #available(iOS 16.2, *), let live = previous as? Activity<RishTaskAttributes> { await live.end(nil, dismissalPolicy: .immediate) }
  }
  func cancelFromActivity(runId: String, conversationId: String) {
    guard current?["conversationId"] == conversationId else { return }
    requestCancel(runId: runId, interrupted: false)
  }
  private func requestCancel(runId: String, interrupted: Bool = true) {
    guard current?["runId"] == runId else { return }
    current?["interrupted"] = interrupted ? "true" : "false"
    current?["stopRequested"] = "true"
    guard let current else { return }
    queue(["action": "cancel", "conversationId": current["conversationId"]!, "runId": current["runId"]!])
    Task {
      guard self.current?["runId"] == runId else { return }
      await endActivity()
    }
  }
  private func queue(_ action: [String: String]) {
    if !actions.contains(action) { actions.append(action); actions = Array(actions.suffix(32)) }
    emit?(action)
  }
  func open(_ url: URL) -> Bool {
    guard url.scheme == "rish", url.host == "task", let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let conversation = parts.queryItems?.first(where: { $0.name == "conversation" })?.value, validID(conversation),
          let run = parts.queryItems?.first(where: { $0.name == "run" })?.value, validID(run) else { return false }
    queue(["action": "open", "conversationId": conversation, "runId": run]); return true
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    await MainActor.run {
      let conversation = notification.request.content.userInfo["conversationId"] as? String
      return conversation == self.visibleConversation ? [] : [.banner, .sound]
    }
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    guard let conversation = response.notification.request.content.userInfo["conversationId"] as? String,
          let run = response.notification.request.content.userInfo["runId"] as? String else { return }
    await MainActor.run { self.queue(["action": "open", "conversationId": conversation, "runId": run]) }
  }
}

@objc(RishTaskExperience)
class RishTaskExperienceModule: RCTEventEmitter {
  override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["RishTaskAction"] }
  override func startObserving() {
    Task { @MainActor in
      TaskExperience.shared.emit = { [weak self] action in
        var envelope: [String: Any] = action; envelope["schema_version"] = 1
        if let data = try? JSONSerialization.data(withJSONObject: envelope), let json = String(data: data, encoding: .utf8) {
          self?.sendEvent(withName: "RishTaskAction", body: json)
        }
      }
    }
  }
  override func stopObserving() { Task { @MainActor in TaskExperience.shared.emit = nil } }
  @objc(handle:resolver:rejecter:)
  func handle(_ input: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { @MainActor in
      do {
        let value = try await TaskExperience.shared.handle(input)
        let data = try JSONSerialization.data(withJSONObject: ["schema_version": 1, "ok": true, "value": value])
        resolve(String(data: data, encoding: .utf8))
      } catch { reject("E_TASK_EXPERIENCE", "Task service unavailable", nil) }
    }
  }
}
