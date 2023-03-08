// @see https://docs.aircode.io/guide/functions/
const { db } = require('aircode');
const axios = require('axios');
const sha1 = require('sha1');
const xml2js = require('xml2js');

const TOKEN = process.env.TOKEN || ''
const APP_ID = process.env.APP_ID || ''
const APP_SECRET = process.env.APP_SECRET || ''
const ENCODING_AES_KEY = process.env.ENCODING_AES_KEY || ''
const OPENAI_KEY = process.env.OPENAI_KEY || ""; // OpenAI 的 Key
const OPENAI_MODEL = process.env.MODEL || "gpt-3.5-turbo"; // 使用的模型
const OPENAI_MAX_TOKEN = process.env.MAX_TOKEN || 1024; // 最大 token 的值

const LIMIT_HISTORY_MESSAGES = 50 // 限制历史会话最大条数
const ADJACENT_MESSAGE_MAX_INTERVAL_TIME = 5 * 60 * 1000 //相邻两条消息的最大间隔时间

const UNSUPPORTED_MESSAGE_TYPES = {
  image: '暂不支持图片消息',
  voice: '暂不支持语音消息',
  video: '暂不支持视频消息',
  music: '暂不支持音乐消息',
  news: '暂不支持图文消息',
}

const CLEAR_MESSAGE = `✅ 记忆已清除`
const HELP_MESSAGE = `ChatGPT 指令使用指南

Usage:
    /clear    清除上下文
    /help     获取更多帮助
  `

const Message = db.table('messages')
const Event = db.table('events')


function responseText({ FromUserName, ToUserName}, content) {
  const timestamp = Date.now();
  return `
  <xml>
    <ToUserName><![CDATA[${FromUserName}]]></ToUserName>
    <FromUserName><![CDATA[${ToUserName}]]></FromUserName>
    <CreateTime>${timestamp}</CreateTime>
    <MsgType><![CDATA[text]]></MsgType>
    <Content><![CDATA[${content}]]></Content>
  </xml>
  `
}


async function processCMD(sessionId, msgid, question) {
  // 清理历史会话
  if (question === '/clear') {
    const now = new Date();
    await Message.where({ sessionId }).set({ deletedAt: now }).save()
    return CLEAR_MESSAGE;
  }
  else {
    return HELP_MESSAGE;
  }
}


// 构建 prompt
async function buildOpenAIPrompt(sessionId, question) {
  let prompt = [];

  // 获取最近 1 小时内的历史会话
  const now = new Date();
  const earliestAt = new Date(now.getTime() - (60 * 60 * 1000))
  const historyMessages = await Message.where({
    sessionId,
    deletedAt: db.exists(false),
    createdAt: db.gt(earliestAt),
  }).sort({ createdAt: -1 }).limit(LIMIT_HISTORY_MESSAGES).find();

  let lastMessageTime = now;
  let tokenSize = 0;
  for (const message of historyMessages) {
    // 如果历史会话记录大于 OPENAI_MAX_TOKEN 或 两次会话间隔超过 10 分钟，则停止添加历史会话
    const timeSinceLastMessage = lastMessageTime ? lastMessageTime - message.createdAt : 0;
    if (tokenSize > OPENAI_MAX_TOKEN || timeSinceLastMessage > ADJACENT_MESSAGE_MAX_INTERVAL_TIME) {
      break
    }

    prompt.unshift({ role: 'assistant', content: message.answer, });
    prompt.unshift({ role: 'user', content: message.question, });
    tokenSize += message.token;
    lastMessageTime = message.createdAt;
  }

  prompt.push({ role: 'user', content: question });
  return prompt;
}


// 获取 OpenAI API 的回复
async function fetchOpenAIReply(prompt) {
  const data = JSON.stringify({
    model: OPENAI_MODEL,
    messages: prompt
  });

  const config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    data: data,
    timeout: 50000
  };

  try {
      const response = await axios(config);
      if (response.status === 429) {
        console.error(response.data);
        return {
          error: '问题太多了，我有点眩晕，请稍后再试'
        }
      }
      // 去除多余的换行
      return {
        answer: response.data.choices[0].message.content.replace("\n\n", ""),
      }
  } catch(e){
     console.error(e.response.data)
     return {
      error: "问题太难了 出错了. (uДu〃).",
    }
  }

}

// 处理文本回复消息
async function replyText(sessionId, { MsgId: msgid, Content: content }) {
  const question = content.trim()

  // 发送指令
  if (question.startsWith('/')) {
    return await processCMD(sessionId, msgid, question);
  }

  // 回复内容
  const prompt = await buildOpenAIPrompt(sessionId, question);
  const { error, answer } = await fetchOpenAIReply(prompt);
  if (error) {
    console.error(`sessionId: ${sessionId}; question: ${question}; error: ${error}`);
    return error;
  }

  console.debug(`sessionId: ${sessionId}; question: ${question}; answer: ${answer}`);

  // 保存消息
  const token = question.length + answer.length
  await Message.save({ sessionId, msgid, question, answer, token, });

  return answer;
}


// 验证是否重复的推送事件
async function duplicateEvent(message) {
  const { MsgId: eventId } = message;
  const count = await Event.where({ event_id: eventId }).count();
  if (count != 0) {
    return true;
  }

  await Event.save({ event_id: eventId, message: message });
  return false;
}


module.exports = async function(params, context) {
  const requestId = context.headers['x-aircode-request-id'];

  // 签名验证
  if (context.method === 'GET') {
    const _sign = sha1(new Array(TOKEN, params.timestamp, params.nonce).sort().join(''))
    if (_sign !== params.signature) {
      context.status(403)
      return 'Forbidden'
    }

    return params.echostr
  }

  // 解析 XML 数据
  let message;
  xml2js.parseString(params, { explicitArray: false }, function(err, result) {
    if (err) {
      console.error(`[${requestId}] parse xml error: `, err);
      return
    }
    message = result.xml
  })
  console.log(`[${requestId}] message: `, message);

  // 验证是否为重复推送事件
  if (await duplicateEvent(message)) {
    console.debug(`[${requestId}] duplicate message: `, message);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // 尝试检查 10 次历史消息是否已处理完
    for (let i=0; i < 10; i++) {
      const _message = await Message.where({ msgid: message.MsgId }).sort({ createdAt: -1 }).findOne();
      if (_message) {
        return responseText(message, _message.answer)
      }
      await sleep(500.0)
    }
  }

  // 处理文本消息
  if (message.MsgType === 'text') {
    const sessionId = message.FromUserName;
    const content = await replyText(sessionId, message);
    return responseText(message, content);
  }

  // 处理暂不支持的消息类型
  if (message.MsgType in UNSUPPORTED_MESSAGE_TYPES) {
    return responseText(
      message,
      UNSUPPORTED_MESSAGE_TYPES[message.MsgType],
    )
  }
  return 'success'
}