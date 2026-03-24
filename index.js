const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// ===== GAS URL =====
const GAS_WEB_APP_URL =
  "https://script.google.com/macros/s/AKfycbxkmNffJmVgALmvM1pjeTz72itaqU6kEuEzJKCwE8gN3liafEzF8i-1G2dHRdPMx7Kyxg/exec";

// ===== 管理者LINE userId =====
const ADMIN_USERS = [
  "U6b698f77fef818c8430066ddb7ccfb2a",
  "Ub9e2aca9918b7cc0c8cf350a1afb483b",
];

// ===== 枝分かれ用カテゴリ =====
const COURSE_GROUPS = ["保育園便", "丸大", "IH", "大地", "その他", "スポット便"];

const COURSES_BY_GROUP = {
  保育園便: ["保A", "保B", "保C", "保E"],
  丸大: ["丸大E", "丸大L"],
  IH: ["IH2", "IH10", "IH13"],
  大地: ["大地ア", "大地イ"],
  その他: ["チーズ", "焼き鳥", "うどん"],
};

const CHECK_OPTIONS = ["点呼OK", "問題あり"];

// ユーザーごとの途中状態
const userStates = {};

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return;
  if (!event.message || event.message.type !== "text") return;

  const text = (event.message.text || "").trim();
  const replyToken = event.replyToken;
  const userId = event.source.userId || "";

  if (!userId) return;

  // どこでもキャンセル可能
  if (text === "キャンセル") {
    delete userStates[userId];
    return replyText(replyToken, "操作をキャンセルしました。最初からやり直してください。");
  }

  // ===== 出発報告スタート =====
  if (text === "出発報告") {
    userStates[userId] = {
      flow: "departure",
      step: "group",
    };
    return replyQuickReply(replyToken, "系統を選択してください", COURSE_GROUPS);
  }

  // ===== 終了報告スタート =====
  if (text === "終了報告") {
    userStates[userId] = {
      flow: "finish",
      step: "group",
    };
    return replyQuickReply(replyToken, "系統を選択してください", COURSE_GROUPS);
  }

  const state = userStates[userId];

  if (!state) {
    return replyText(
      replyToken,
      "リッチメニューの「出発報告」「終了報告」「キャンセル」から操作してください。"
    );
  }

  // =========================
  // 出発報告フロー
  // =========================
  if (state.flow === "departure") {
    // 1) 系統選択
    if (state.step === "group") {
      if (!COURSE_GROUPS.includes(text)) {
        return replyQuickReply(replyToken, "系統を選択してください", COURSE_GROUPS);
      }

      state.group = text;

      if (text === "スポット便") {
        state.step = "spot_course";
        return replyText(replyToken, "スポット便のコース名を入力してください。");
      }

      state.step = "course";
      return replyQuickReply(
        replyToken,
        `${text} のコースを選択してください`,
        COURSES_BY_GROUP[text]
      );
    }

    // 2) スポット便自由入力
    if (state.step === "spot_course") {
      state.course = text;
      state.step = "check";

      return replyQuickReply(
        replyToken,
        `出発点呼を確認してください\n\n` +
          `コース: ${state.course}\n` +
          `・アルコール問題なし\n` +
          `・免許携帯あり\n` +
          `・体調問題なし`,
        CHECK_OPTIONS
      );
    }

    // 3) コース選択
    if (state.step === "course") {
      const validCourses = COURSES_BY_GROUP[state.group] || [];
      if (!validCourses.includes(text)) {
        return replyQuickReply(
          replyToken,
          `${state.group} のコースを選択してください`,
          validCourses
        );
      }

      state.course = text;
      state.step = "check";

      return replyQuickReply(
        replyToken,
        `出発点呼を確認してください\n\n` +
          `コース: ${state.course}\n` +
          `・アルコール問題なし\n` +
          `・免許携帯あり\n` +
          `・体調問題なし`,
        CHECK_OPTIONS
      );
    }

    // 4) 点呼確認
    if (state.step === "check") {
      const employeeName = await getEmployeeNameFromSheet(userId);

      if (text === "問題あり") {
        const doneMessage =
          `出発点呼で「問題あり」を受け付けました。\n` +
          `管理者へ直接連絡してください。`;

        // 返信を最優先
        await replyText(replyToken, doneMessage);

        // 記録と通知は後で
        sendLog(userId, "出発点呼異常", state.course || "", "問題あり").catch(console.error);
        notifyAdmins(
          `⚠️出発点呼異常\n\n` +
            `送信者: ${employeeName}\n` +
            `コース: ${state.course || ""}\n` +
            `内容: 問題あり`
        ).catch(console.error);

        delete userStates[userId];
        return;
      }

      if (text === "点呼OK") {
        const doneMessage =
          `出発｜${state.course}\n` +
          `点呼OK を受け付けました。\n` +
          `今日も安全運転でお願いします。`;

        // 返信を最優先
        await replyText(replyToken, doneMessage);

        // 記録は後で
        sendLog(userId, "出発", state.course, "点呼OK").catch(console.error);

        delete userStates[userId];
        return;
      }

      return replyQuickReply(
        replyToken,
        `出発点呼を確認してください\n\n` +
          `コース: ${state.course}\n` +
          `・アルコール問題なし\n` +
          `・免許携帯あり\n` +
          `・体調問題なし`,
        CHECK_OPTIONS
      );
    }
  }

  // =========================
  // 終了報告フロー
  // =========================
  if (state.flow === "finish") {
    // 1) 系統選択
    if (state.step === "group") {
      if (!COURSE_GROUPS.includes(text)) {
        return replyQuickReply(replyToken, "系統を選択してください", COURSE_GROUPS);
      }

      state.group = text;

      if (text === "スポット便") {
        state.step = "spot_course";
        return replyText(replyToken, "終了したスポット便のコース名を入力してください。");
      }

      state.step = "course";
      return replyQuickReply(
        replyToken,
        `${text} のコースを選択してください`,
        COURSES_BY_GROUP[text]
      );
    }

    // 2) スポット便自由入力
    if (state.step === "spot_course") {
      state.course = text;

      const doneMessage = `終了｜${state.course} を受け付けました。\n本日もお疲れさまでした。`;

      // 返信優先
      await replyText(replyToken, doneMessage);

      // 記録後回し
      sendLog(userId, "終了", state.course, "終了受付").catch(console.error);

      delete userStates[userId];
      return;
    }

    // 3) コース選択
    if (state.step === "course") {
      const validCourses = COURSES_BY_GROUP[state.group] || [];
      if (!validCourses.includes(text)) {
        return replyQuickReply(
          replyToken,
          `${state.group} のコースを選択してください`,
          validCourses
        );
      }

      state.course = text;

      const doneMessage = `終了｜${state.course} を受け付けました。\n本日もお疲れさまでした。`;

      // 返信優先
      await replyText(replyToken, doneMessage);

      // 記録後回し
      sendLog(userId, "終了", state.course, "終了受付").catch(console.error);

      delete userStates[userId];
      return;
    }
  }

  return replyText(replyToken, "もう一度、リッチメニューから操作してください。");
}

// ===== スプレッドシートの users シートから社員名取得 =====
async function getEmployeeNameFromSheet(userId) {
  if (!GAS_WEB_APP_URL) return "不明";

  try {
    const response = await axios.get(GAS_WEB_APP_URL, {
      params: {
        mode: "getEmployeeName",
        userId,
      },
    });

    if (response.data && response.data.employeeName) {
      return response.data.employeeName || "不明";
    }

    return "不明";
  } catch (error) {
    console.error("社員名取得エラー:", error.message);
    return "不明";
  }
}

// ===== ログ送信 =====
async function sendLog(userId, type, course, message) {
  if (!GAS_WEB_APP_URL) {
    console.log("GAS_WEB_APP_URL 未設定");
    return;
  }

  try {
    await axios.post(GAS_WEB_APP_URL, {
      userId,
      type,
      course,
      message,
    });
  } catch (error) {
    console.error("ログ送信エラー:", error.message);
  }
}

// ===== 管理者複数通知 =====
async function notifyAdmins(text) {
  if (!ADMIN_USERS || ADMIN_USERS.length === 0) {
    console.log("ADMIN_USERS 未設定");
    return;
  }

  const promises = ADMIN_USERS.map((adminId) =>
    client.pushMessage({
      to: adminId,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    })
  );

  await Promise.allSettled(promises);
}

// ===== LINE返信 =====
async function replyText(replyToken, text) {
  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text,
      },
    ],
  });
}

async function replyQuickReply(replyToken, promptText, labels) {
  const items = labels.map((label) => ({
    type: "action",
    action: {
      type: "message",
      label,
      text: label,
    },
  }));

  return client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text: promptText,
        quickReply: {
          items,
        },
      },
    ],
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});