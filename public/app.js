const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const $ = (id) => document.getElementById(id);

let state = null;
let settingsFor = null; // The account whose settings are in the form.
let accountId = new URLSearchParams(location.search).get("account");
// Edits not saved yet, by post ID. These survive redraws of the page.
const unsaved = new Map();

async function api(path, { method = "POST", body = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/login")) {
    showLogin();
    throw new Error("Sign in first.");
  }
  if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
}

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 8000 : 3000);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

/** Runs an action with the button disabled, then redraws from the result. */
async function act(button, action, success, busyLabel) {
  const label = button.textContent;
  button.disabled = true;
  if (busyLabel) button.textContent = busyLabel;
  try {
    render(await action());
    if (success) toast(success);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function formatWhen(iso) {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: state.settings.timezone ?? undefined,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function postUrl(post) {
  if (!post.linkedin_urn || post.linkedin_urn.startsWith("dry-run:")) return null;
  return `https://www.linkedin.com/feed/update/${post.linkedin_urn}/`;
}

function button(label, onClick, className = "") {
  const b = el("button", { type: "button", textContent: label, className });
  b.addEventListener("click", () => onClick(b));
  return b;
}

function draftCard(post) {
  const value = unsaved.get(post.id) ?? post.body;
  const lines = value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 75)), 0);
  const text = el("textarea", { value, rows: Math.max(8, lines + 1), ariaLabel: "Post text" });
  const counter = el("span", { className: "count" });
  const showCount = () => {
    counter.textContent = `${text.value.length} / ${state.maxLength} characters`;
    counter.classList.toggle("over", text.value.length > state.maxLength);
  };
  text.addEventListener("input", () => {
    unsaved.set(post.id, text.value);
    showCount();
  });
  showCount();

  // Saves edits first, so publishing always uses the text on screen.
  const save = async () => {
    if (text.value !== post.body) await api(`/api/posts/${post.id}/update`, { body: { body: text.value } });
    unsaved.delete(post.id);
  };

  const approve = button(state.nextSlot ? `Approve: post ${formatWhen(state.nextSlot)}` : "Approve", (b) => {
    if (!state.nextSlot) return toast("Choose your posting days under When to post first.", true);
    act(b, async () => {
      await save();
      return api(`/api/posts/${post.id}/schedule`);
    }, "Approved. It will post at the time shown.");
  }, "primary");

  const postNow = button(state.dryRun ? "Test post now" : "Post now", (b) => {
    if (!state.dryRun && !confirm("Publish this to LinkedIn right now?")) return;
    act(b, async () => {
      await save();
      return api(`/api/posts/${post.id}/publish`);
    }, state.dryRun ? null : "Posted to LinkedIn.");
  });

  const remove = button("Delete", (b) => {
    if (!confirm("Delete this draft?")) return;
    unsaved.delete(post.id);
    act(b, () => api(`/api/posts/${post.id}`, { method: "DELETE" }));
  }, "quiet");

  const feedback = el("input", { placeholder: "e.g. shorter, more personal, less formal", ariaLabel: "What should change" });
  const redo = button("Rewrite", (b) => {
    if (text.value !== post.body && !confirm("Rewriting replaces your edits. Continue?")) return;
    act(b, async () => {
      const result = await api(`/api/posts/${post.id}/regenerate`, { body: { feedback: feedback.value } });
      unsaved.delete(post.id);
      return result;
    }, "Rewritten.", "Rewriting…");
  });

  const when = el("input", { type: "datetime-local", ariaLabel: "Date and time" });
  const pickTime = button("Approve for this time", (b) => {
    if (!when.value) return toast("Pick a date and time first.", true);
    act(b, async () => {
      await save();
      return api(`/api/posts/${post.id}/schedule`, { body: { at: new Date(when.value).toISOString() } });
    }, "Approved.");
  });

  const failure = post.status === "failed"
    ? el("p", { className: "failure", textContent: `This didn't post: ${post.error}` })
    : null;

  let sources = null;
  if (post.sources.length) {
    sources = el("details", { className: "sources" },
      el("summary", { textContent: `Sources (${post.sources.length}): check these before posting` }),
      el("ul", {}, ...post.sources.map((source) => el("li", {},
        el("a", { href: source.url, target: "_blank", rel: "noopener", textContent: source.title })))),
    );
  } else if (post.pillar_type === "news") {
    sources = el("p", { className: "failure", textContent: "No sources were attached. Check every fact before posting." });
  }

  return el("article", { className: "card post" },
    el("div", { className: "post-head" },
      el("span", { className: "badge", textContent: post.status === "failed" ? "Didn't post" : "Draft" }),
      el("p", { className: "topic", textContent: post.topic }),
    ),
    failure,
    text,
    counter,
    sources,
    el("div", { className: "actions" }, approve, postNow, remove),
    el("details", { className: "option" },
      el("summary", { textContent: "Ask the AI to rewrite it" }),
      el("div", { className: "inline" }, feedback, redo),
    ),
    el("details", { className: "option" },
      el("summary", { textContent: "Post at a different time" }),
      el("div", { className: "inline" }, when, pickTime),
    ),
  );
}

function scheduledCard(post) {
  return el("article", { className: "card post" },
    el("div", { className: "post-head" },
      el("span", { className: "badge ok", textContent: `Posts ${formatWhen(post.scheduled_at)}` }),
      el("p", { className: "topic", textContent: post.topic }),
    ),
    el("p", { className: "body", textContent: post.body }),
    el("div", { className: "actions" },
      button("Edit or hold back", (b) => act(b, () => api(`/api/posts/${post.id}/unschedule`),
        "Moved back to review. It won't post until you approve it again.")),
      button("Delete", (b) => {
        if (confirm("Delete this scheduled post?")) act(b, () => api(`/api/posts/${post.id}`, { method: "DELETE" }));
      }, "quiet"),
    ),
  );
}

function historyCard(post) {
  const url = postUrl(post);
  let meta;
  if (post.status === "publishing") meta = "Publishing… If this doesn't clear, check LinkedIn before posting again.";
  else if (url) meta = `Posted ${formatWhen(post.published_at)}`;
  else meta = `Dry run ${formatWhen(post.published_at)}: not sent to LinkedIn`;

  return el("article", { className: "card post compact" },
    el("p", { className: "when", textContent: meta }),
    el("p", { className: "body", textContent: post.body }),
    url ? el("a", { href: url, target: "_blank", rel: "noopener", textContent: "View on LinkedIn" }) : null,
  );
}

function renderList(sectionId, listId, posts, card) {
  $(sectionId).hidden = posts.length === 0;
  const list = $(listId);
  // Redrawing would wipe out text being typed, so leave a focused list alone.
  if (list.contains(document.activeElement) && document.activeElement.matches("textarea, input")) return;
  list.replaceChildren(...posts.map(card));
}

function renderHeader() {
  const box = $("connection");
  const { account, accounts, linkedinConfigured, dryRun } = state;
  const parts = [];

  const picker = el("select", { ariaLabel: "Account" });
  picker.append(...accounts.map((a) => el("option", { value: a.id, textContent: a.name, selected: a.id === account.id })));
  picker.addEventListener("change", () => loadAccount(picker.value));
  parts.push(picker);

  parts.push(el("span", { className: "who", textContent: state.user.username }));
  parts.push(button("Sign out", async () => {
    await api("/api/logout").catch(() => {});
    location.href = "/";
  }, "quiet"));

  if (account.connected) {
    parts.push(button("Disconnect", (b) => {
      if (confirm("Disconnect LinkedIn? Scheduled posts for this account will fail until you reconnect.")) {
        act(b, () => api(`/api/accounts/${account.id}/disconnect`));
      }
    }, "quiet"));
  }
  if (linkedinConfigured) {
    const label = account.connected ? "Add account" : "Connect LinkedIn";
    parts.push(el("a", { href: "/auth/linkedin", className: `button${account.connected ? "" : " primary"}`, textContent: label }));
  } else {
    parts.push(el("span", { textContent: "LinkedIn not set up" }));
  }
  if (accounts.length > 1) {
    parts.push(button("Remove", (b) => {
      if (confirm(`Remove ${account.name} and all of its posts from this app? This can't be undone.`)) {
        act(b, () => api(`/api/accounts/${account.id}`, { method: "DELETE" }));
      }
    }, "quiet"));
  }
  box.replaceChildren(...parts);

  const banners = [];
  if (dryRun) {
    banners.push(el("p", { className: "banner", textContent: "Dry run is on. Posts stay in this app and nothing is sent to LinkedIn." }));
  }
  if (account.connected) {
    const days = Math.ceil((Date.parse(account.expiresAt) - Date.now()) / 86400000);
    if (days <= 7) {
      const message = days <= 0
        ? "Your LinkedIn connection has expired, so scheduled posts will fail. "
        : `Your LinkedIn connection expires in ${days} day${days === 1 ? "" : "s"}. `;
      banners.push(el("p", { className: "banner warn" },
        message, el("a", { href: "/auth/linkedin", textContent: "Reconnect" })));
    }
  } else if (!dryRun) {
    banners.push(el("p", { className: "banner warn", textContent: "Connect LinkedIn before scheduling posts." }));
  }
  if (account.dailyError) {
    banners.push(el("p", { className: "banner warn", textContent: account.dailyError }));
  }
  $("banners").replaceChildren(...banners);
}

function scheduleMode(settings) {
  if (!settings.dailyDrafts) return "off";
  return settings.autoPostDaily ? "auto" : "review";
}

function describeSchedule(settings) {
  if (!settings.days.length) return "no days chosen";
  const days = settings.days.length === 7 ? "Every day"
    : settings.days.join() === "1,2,3,4,5" ? "Mon–Fri"
    : settings.days.map((d) => DAY_NAMES[d]).join(", ");
  const how = { auto: "automatically", review: "after you approve", off: "your own topics only" }[scheduleMode(settings)];
  return `${days} at ${settings.time}, ${how}`;
}

function fillSettings() {
  const { settings } = state;
  $("days").replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map((i) => {
    const box = el("input", { type: "checkbox", value: i, checked: settings.days.includes(i) });
    return el("label", { className: "day" }, box, el("span", { textContent: DAY_NAMES[i] }));
  }));
  $("time").value = settings.time;
  for (const radio of document.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === scheduleMode(settings);
  $("timezone").value = settings.timezone ?? "";
  $("voice").value = settings.voice;
  $("autoApprove").checked = settings.autoApprove;
  $("learning").value = settings.learning;
  $("pillars").replaceChildren(...settings.pillars.map(pillarRow));
  settingsFor = state.account.id;
}

function renderSpending() {
  $("schedule-summary").textContent = describeSchedule(state.settings);
  const { budget } = state;
  $("spending").textContent = budget?.limit
    ? `AI spending this month, for everyone using the app: $${budget.spent.toFixed(2)} of $${budget.limit.toFixed(2)}. Writing pauses if the limit is reached, until next month.`
    : "";
}

function pillarRow(pillar) {
  const row = el("div", { className: "pillar" });
  row.dataset.type = pillar.type;
  const name = el("input", { value: pillar.name, placeholder: "Topic name", ariaLabel: "Topic name", required: true });
  const description = el("textarea", { value: pillar.description, rows: 2, placeholder: "What these posts cover", ariaLabel: "Topic description" });
  const kind = { news: "Researched on the web, with sources", learning: "Uses what you're learning, below" }[pillar.type];
  row.append(name, description, ...(kind ? [el("small", { textContent: kind })] : []),
    button("Remove", () => row.remove(), "quiet"));
  return row;
}

function readPillars() {
  return [...$("pillars").children].map((row) => ({
    name: row.querySelector("input").value,
    description: row.querySelector("textarea").value,
    type: row.dataset.type,
  }));
}

function uploadForm(buttonLabel) {
  const file = el("input", { type: "file", accept: "application/pdf,.pdf", ariaLabel: "Profile PDF" });
  const pasted = el("textarea", { rows: 4, placeholder: "Your headline, About section, experience and skills" });
  const run = button(buttonLabel, (b) => {
    act(b, async () => {
      const body = {};
      if (file.files[0]) {
        if (file.files[0].size > MAX_PDF_BYTES) throw new Error("That PDF is over 10 MB.");
        body.pdf = await toBase64(file.files[0]);
      } else {
        body.text = pasted.value;
      }
      const result = await api(`/api/accounts/${state.account.id}/analyze`, { body });
      settingsFor = null;
      return result;
    }, "Profile check finished.", "Checking your profile…");
  }, "primary");

  return el("div", { className: "upload" },
    el("ol", {},
      el("li", { textContent: "Open your profile on LinkedIn." }),
      el("li", { textContent: "Click More or Resources, then Save to PDF." }),
      el("li", { textContent: "Upload the file here." }),
    ),
    file,
    el("details", {}, el("summary", { textContent: "Paste your profile instead" }), pasted),
    run,
  );
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function copyButton(text) {
  return button("Copy", async () => {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  });
}

function renderProfile() {
  const box = $("profile");
  // Redrawing would clear a chosen file, so leave the form alone while it's in use.
  if (box.dataset.for === `${state.account.id}:${state.analysis?.analyzedAt}`) return;
  box.dataset.for = `${state.account.id}:${state.analysis?.analyzedAt}`;

  const { analysis } = state;
  $("profile-summary").textContent = analysis ? `${analysis.score}/100` : "start here";
  $("profile-card").open = !analysis;
  if (!analysis) {
    box.replaceChildren(
      el("h2", { className: "card-title", textContent: "Start with a profile check" }),
      el("p", { className: "lead", textContent: "The AI reviews your profile, shows what to fix, and uses it to shape every post." }),
      uploadForm("Check my profile"),
    );
    return;
  }

  box.replaceChildren(
    el("div", { className: "score-row" },
      el("div", { className: "score" }, el("strong", { textContent: analysis.score }), el("span", { textContent: "/100" })),
      el("div", {},
        el("h2", { className: "card-title", textContent: "Profile health" }),
        el("p", { className: "lead", textContent: analysis.verdict }),
      ),
    ),
    el("p", {}, el("b", { textContent: "Positioning: " }), analysis.positioning),
    el("p", {}, el("b", { textContent: "Audience: " }), analysis.audience),
    el("details", {},
      el("summary", { textContent: "What to fix first" }),
      el("div", { className: "fixes" }, ...analysis.fixes.map((fix) => el("div", { className: "fix" },
        el("b", { textContent: fix.title }),
        el("p", { textContent: fix.why }),
        fix.suggestedText ? el("blockquote", { textContent: fix.suggestedText }) : null,
        fix.suggestedText ? copyButton(fix.suggestedText) : null,
      ))),
    ),
    el("details", {},
      el("summary", { textContent: "Section scores" }),
      el("div", { className: "sections" }, ...analysis.sections.map((section) => {
        const meter = el("meter", { min: 0, max: 100, value: section.score, ariaLabel: `${section.name} score` });
        return el("div", { className: "section-score" },
          el("div", { className: "section-head" }, el("b", { textContent: section.name }), el("span", { textContent: section.score })),
          meter,
          el("p", { textContent: section.finding }),
        );
      })),
    ),
    el("details", {},
      el("summary", { textContent: "Check again after updating my profile" }),
      uploadForm("Check again"),
    ),
    el("p", { className: "note", textContent: `Checked ${formatWhen(analysis.analyzedAt)}. This is the AI's review of your PDF, not a LinkedIn score. Your photo, banner and activity aren't in the PDF, so they weren't checked.` }),
  );
}

function render(next) {
  state = next;
  $("auth").hidden = true;
  $("app").hidden = false;
  if ($("people-section").hidden === state.user.isAdmin) {
    $("people-section").hidden = !state.user.isAdmin;
    if (state.user.isAdmin) loadPeople();
  }
  const by = (...statuses) => state.posts.filter((p) => statuses.includes(p.status));
  accountId = state.account.id;
  renderHeader();
  renderProfile();
  $("draft-next").hidden = !state.analysis;
  renderList("drafts-section", "drafts", by("draft", "failed"), draftCard);
  renderList(
    "scheduled-section",
    "scheduled",
    by("scheduled").sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)),
    scheduledCard,
  );
  renderList("history-section", "history", by("published", "publishing"), historyCard);
  if (settingsFor !== state.account.id) fillSettings();
  renderSpending();
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const b = $("write");
  const auto = state.settings.autoApprove;
  act(b, async () => {
    const result = await api(`/api/accounts/${state.account.id}/posts`, {
      body: { topic: $("topic").value, notes: $("notes").value },
    });
    $("topic").value = "";
    $("notes").value = "";
    return result;
  }, auto ? "Written and scheduled." : "Draft ready.", "Writing…");
});

/** The draft is written an hour before the posting time, so there's a chance to check it. */
function hourBefore(time) {
  const [h, m] = time.split(":").map(Number);
  const minutes = Math.max(0, h * 60 + m - 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

$("schedule").addEventListener("submit", (event) => {
  event.preventDefault();
  const days = [...$("days").querySelectorAll("input:checked")].map((box) => Number(box.value));
  const mode = document.querySelector('input[name="mode"]:checked')?.value ?? "review";
  act(event.submitter, () => api(`/api/accounts/${state.account.id}/settings`, {
    body: {
      days,
      time: $("time").value,
      draftTime: hourBefore($("time").value),
      dailyDrafts: mode !== "off",
      autoPostDaily: mode === "auto",
    },
  }), "Saved.");
});

$("style").addEventListener("submit", (event) => {
  event.preventDefault();
  act(event.submitter, () => api(`/api/accounts/${state.account.id}/settings`, {
    body: {
      timezone: $("timezone").value.trim(),
      voice: $("voice").value,
      learning: $("learning").value,
      autoApprove: $("autoApprove").checked,
      pillars: readPillars(),
    },
  }), "Saved.");
});

$("add-pillar").addEventListener("click", () => {
  $("pillars").append(pillarRow({ name: "", description: "", type: "expertise" }));
});

$("draft-next").addEventListener("click", (event) => {
  act(event.currentTarget, () => api(`/api/accounts/${state.account.id}/draft-next`), "Draft ready.", "Writing…");
});

const fetchState = () => api(`/api/state${accountId ? `?account=${accountId}` : ""}`, { method: "GET" });

async function loadAccount(id) {
  accountId = id;
  let data = await fetchState();
  if (!data.settings.timezone) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    data = await api(`/api/accounts/${data.account.id}/settings`, { body: { timezone } });
  }
  render(data);
}

// People: invite links and password resets, for the app's owner.

function renderPeople(people) {
  $("people").replaceChildren(...people.map((person) => el("div", { className: "person" },
    el("span", { textContent: person.isAdmin ? `${person.username} (owner)` : person.username }),
    el("div", { className: "actions" },
      button("Password reset link", (b) => peopleAction(b, `/api/people/${person.id}/reset`, {},
        `Send this to ${person.username}. It lets them choose a new password.`)),
      person.isAdmin ? null : button("Remove", (b) => {
        if (confirm(`Remove ${person.username}, their LinkedIn accounts and all their posts? This can't be undone.`)) {
          peopleAction(b, `/api/people/${person.id}`, { method: "DELETE" });
        }
      }, "quiet"),
    ),
  )));
}

async function peopleAction(b, path, options, linkNote) {
  b.disabled = true;
  try {
    const result = await api(path, options);
    renderPeople(result.people);
    if (result.link) showLink(result.link, linkNote);
  } catch (err) {
    toast(err.message, true);
  } finally {
    b.disabled = false;
  }
}

function showLink(link, note) {
  const field = el("input", { value: link, readOnly: true, ariaLabel: "Link" });
  $("invite-result").replaceChildren(el("div", { className: "invite-link" },
    el("p", { className: "note", textContent: note }), field, copyButton(link)));
  field.select();
}

async function loadPeople() {
  try {
    renderPeople((await api("/api/people", { method: "GET" })).people);
  } catch (err) {
    toast(err.message, true);
  }
}

$("invite").addEventListener("click", (event) => {
  peopleAction(event.currentTarget, "/api/people/invite", {},
    "Send this link to the person you're inviting. They choose their own username and password, then connect their LinkedIn.");
});

// Signing in.

function field(label, props) {
  const input = el("input", { required: true, ...props });
  return [el("label", {}, label, input), input];
}

function authForm({ title, intro, fields, submitLabel, onSubmit }) {
  const inputs = {};
  const labels = fields.map(([key, label, props]) => {
    const [wrapper, input] = field(label, props);
    inputs[key] = input;
    return wrapper;
  });
  const submit = el("button", { type: "submit", className: "primary", textContent: submitLabel });
  const form = el("form", {}, ...labels, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
      await onSubmit(values);
    } catch (err) {
      toast(err.message, true);
    } finally {
      submit.disabled = false;
    }
  });
  $("connection").replaceChildren();
  $("app").hidden = true;
  $("auth").hidden = false;
  $("auth").replaceChildren(
    el("h2", { className: "card-title", textContent: title }),
    intro ? el("p", { className: "lead", textContent: intro }) : null,
    form,
  );
  form.querySelector("input")?.focus();
}

const USERNAME = ["username", "Username", { autocomplete: "username", minLength: 3, maxLength: 32 }];
const NEW_PASSWORD = ["password", "Password (at least 8 characters)", { type: "password", autocomplete: "new-password", minLength: 8 }];

function showLogin() {
  authForm({
    title: "Sign in",
    fields: [USERNAME, ["password", "Password", { type: "password", autocomplete: "current-password" }]],
    submitLabel: "Sign in",
    onSubmit: async (values) => {
      await api("/api/login", { body: values });
      await enterApp();
    },
  });
}

function showSetup(setupCodeRequired) {
  const fields = [USERNAME, NEW_PASSWORD];
  if (setupCodeRequired) fields.push(["setupCode", "Setup code (SETUP_CODE from your settings)", { type: "password", autocomplete: "off" }]);
  authForm({
    title: "Create your login",
    intro: "You're the first person here, so you'll be the app's owner. You can invite others afterwards.",
    fields,
    submitLabel: "Create login",
    onSubmit: async (values) => {
      await api("/api/setup", { body: values });
      await enterApp();
    },
  });
}

async function showInvite(token) {
  let invite;
  try {
    invite = await api(`/api/invites/${encodeURIComponent(token)}`, { method: "GET" });
  } catch (err) {
    toast(err.message, true);
    history.replaceState(null, "", "/");
    return start();
  }
  const reset = Boolean(invite.username);
  authForm({
    title: reset ? `Choose a new password for ${invite.username}` : "You're invited",
    intro: reset ? null : "Choose a username and password. Then you'll connect your own LinkedIn account.",
    fields: reset ? [NEW_PASSWORD] : [USERNAME, NEW_PASSWORD],
    submitLabel: reset ? "Save password" : "Create my login",
    onSubmit: async (values) => {
      await api(`/api/invites/${encodeURIComponent(token)}`, { body: values });
      history.replaceState(null, "", "/");
      await enterApp();
    },
  });
}

let refreshing = null;
async function enterApp() {
  await loadAccount(accountId);
  // Picks up drafts and posts the app has made since the page was opened.
  refreshing ??= setInterval(() => {
    if (!$("app").hidden) fetchState().then(render).catch(() => {});
  }, 30000);
}

async function start() {
  const invite = new URLSearchParams(location.search).get("invite");
  if (invite) return showInvite(invite);
  const session = await api("/api/session", { method: "GET" });
  if (session.user) return enterApp();
  if (session.needsSetup) return showSetup(session.setupCodeRequired);
  showLogin();
}

start().catch((err) => toast(err.message, true));
