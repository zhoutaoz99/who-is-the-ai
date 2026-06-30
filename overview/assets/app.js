/* =========================================================
   《谁是AI》系统全景导览 · 交互
   - scrollytelling 引擎（双回路 / 三层 / 流水线）
   - 流水线小车 + 产物标签
   - 九条洞察卡片 · 模块深潜折叠卡（数据驱动注入）
   - 进度条 / 导航高亮 / 棘轮 / reveal
   ========================================================= */

(function () {
  "use strict";

  /* ---------- 数据：九条洞察 ---------- */
  const INSIGHTS = [
    { f: "AI 输在博弈缺位，不在文笔。",
      b: "大模型默认是「有问必答、礼貌周到的好聊天对象」；但这局里所有真人都自私、片面、爱算计。语言再自然，只回应不博弈，几轮内必死。→ <b>AI 玩家的目标从「说得像人」改成「想活下去的骗子：每轮别成为最可疑的人」。</b>" },
    { f: "对 AI 来说，「展示能力 = 自杀」。",
      b: "答对一道刁钻测试题，比答错暴露得更彻底。→ <b>抗测试一律人设化回避（嫌烦 / 装没懂 / 怼回去），把能力藏死。</b>" },
    { f: "拟人 = 融入这群人这场对话，不是表演「人味」。",
      b: "最好的伪装是「略低于平均存在感的普通人」，镜像房间的语气与能量。→ <b>反对任何单维度过度优化——疯狂加错别字、拼命玩梗反而露馅。</b>" },
    { f: "没有度量就没有迭代；而这个游戏自带真值。",
      b: "真人投票就是一台免费的、持续运转的标注机。→ <b>整套优化建立在「真人对局存活 / 被识破」这个客观真值上，而非主观感觉。</b>" },
    { f: "降方差靠统计，不靠冻结环境。",
      b: "把对手写死能降方差，但会失真。→ <b>对手用「固定剧本 + 活反应」（只固定与 AI 措辞无关的外部冲击），配对评测靠同种子做差消掉共模噪声。</b>" },
    { f: "决策信号 vs 诊断信号必须分离。",
      b: "裁判八维量表信息丰富但易被刷。→ <b>决策只用最接近真值的信号（客观结果 + 盲测可疑度 + 否决）；量表与失败案例只用于诊断「该改哪」，绝不当优化目标。</b>" },
    { f: "三道防自欺闸门，构成只进不退的棘轮。",
      b: "配对 + 显著性（防噪声）、留出集 + 探测轮换（防过拟合）、真人校准（防 Goodhart）。→ <b>噪声驱动的假「进步」过不了重复确认，只有真实增益代代复利。</b>" },
    { f: "覆盖 = 逼近真人失败分布，不是穷举。",
      b: "对局状态空间无穷，穷举不可达且仍会漏真人的骚操作。→ <b>场景库用分层抽样 + 真人失败回灌生长；未知攻击靠提示词的通用回避反射兜底。</b>" },
    { f: "依赖只走契约。",
      b: "模块强相关但不同质、不同步变。→ <b>用稳定 schema 解耦，把跨模块的共享约定沉淀进契约，而非把模块合并。</b>" },
  ];

  /* ---------- 数据：模块深潜 ---------- */
  const MODULES = [
    { icon: "🎭", lane: "online", title: "AI 玩家（被优化对象）",
      one: "在真实房间里聊天盲投的那个 AI：System Prompt + 一张人设卡 + 投票逻辑。",
      contract: "System Prompt 模板末尾插入 4 张人设卡之一，每局随机分配、整局不变；投票阶段单独调用，只输出「代号 + 一句凭感觉的理由」。",
      why: "唯一目标 = 活到第 4 轮，别当这轮票最多的人。「性格本身就是掩护」——懒 / 毒舌 / 玩梗 / 戏精，每种都为「不答测试题、回答片面、主动指认别人」提供天然且合理的借口，不需要「演」。",
      cost: "严丝合缝反而像机器 → 允许偶尔自相矛盾、忘词、错别字；但别满屏错字（刻意装人也会露馅）。" },
    { icon: "⚙️", lane: "offline", title: "对局引擎",
      one: "按场景把一局从头跑到尾，产出可复现的 MatchRecord；只跑不评分。",
      contract: "输入 <code>Scenario</code>（输入契约），输出 <code>MatchRecord</code>（输出契约，含 probe auto_eval）。",
      why: "用 <code>scripted_intent</code>（固定剧本 + 活反应）——固定与 AI 措辞无关的外部冲击保住配对一致、放活反应保住真实；<code>vote_policy</code> 默认 <code>live</code> 让「AI 表现 ↔ 被票出」不脱钩；移除 <code>intent_schedule</code>，因为强行注入「本轮怀疑谁」会抹掉因果、失真。",
      cost: "探测投放瞬间略生硬，但真人测 AI 也这么突兀；live 投票有成本 → filler 用 rule 缓解。" },
    { icon: "⚖️", lane: "offline", title: "裁判评分",
      one: "把一局变成 ScoreRecord：客观结果指标 + 裁判 LLM 两遍法。",
      contract: "输出 <code>ScoreRecord</code>：盲测可疑度 <code>suspicion_margin</code> + 八维诊断 + 失败案例 + 否决项；支持多裁判集成。",
      why: "主信号选「盲测可疑度（相对 margin）+ 像玩家不像法医」——连续量低方差、相对量贴「相对最可疑才出局」、像玩家才代理真人直觉；用输赢 / 绝对分 / 法医式分析都更差。",
      cost: "代理会漂 → 真人校准纠偏；盲测若做成逐句取证会过度识别 → 守「像玩家」纪律。" },
    { icon: "🧮", lane: "core", title: "★ 评分聚合（核心机制 · 命门）",
      one: "整套沙盒最核心的一环——把成百上千条单局分压成几个明确信号。",
      contract: "四层 key 树 <code>version→scenario→seed→run</code>；聚合顺序固定：run 取均 → (scenario,seed) 配对做差 → scenario 收敛 → 估 CI → 卡 verdict。",
      why: "<b>平均压随机噪声，做差消共模干扰</b>（场景难度）；统计样本单元 N <b>用场景数不是对局数</b>——用对局数当 N 会 CI 虚窄、虚假显著，是头号坑。",
      cost: "聚错一步（尤其 N 与顺序）整套迭代就很努力地朝噪声跑 → 顺序不可跨层、先配对做差再汇总。" },
    { icon: "🧬", lane: "offline", title: "优化器",
      one: "进化的智能变异算子：吃信号，产 1 个带可证伪假设的子版本。",
      contract: "输入瞄准信号 + 失败案例 + 失败记忆；输出 <code>child</code>（PromptVersion + hypothesis + target_dimension）。",
      why: "选「单候选 + 外层派靶」而非一次产 K 个——一次产 K 个会长输出退化、多样性造假、纪律涣散；算子选择 = 破绽类型约束（对路算子表）+ 历史战绩 Top-2 做 A/B。",
      cost: "K 次调用 → 可并行，总成本相近；提示词膨胀 / 打转 → 长度预算 + consolidate + validate_prompt + tried_and_rejected。" },
    { icon: "🎛️", lane: "offline", title: "编排器",
      one: "总控与三道闸的执行处，驱动代际循环。",
      contract: "产出 <code>GenerationEval</code>（每代接受 / 拒绝依据）；维护 <code>PromptVersion</code> 谱系与种群 top-k。",
      why: "决策只用近真值信号（可疑度 + 否决 + 客观结果），不刷八维加权总分；接受闸门 = 可疑度显著降 + 不否决 + 不回退，再过留出集复核。",
      cost: "代理可能漂 → 每 M 代真人校准；翻车回滚，真人为最终裁决。" },
    { icon: "🗂️", lane: "offline", title: "场景库",
      one: "不穷举的对局输入来源：分层抽样 + 真人失败回灌。",
      contract: "产出 <code>Scenario</code> / <code>ProbeBank</code>（输入契约）；optimize / holdout 实例不重叠；维护 ScenarioCoverage / FailureModeLedger。",
      why: "状态空间无穷，穷举不可达且仍漏真人骚操作 → 七维分层抽样 + <code>probe_type×social_situation</code> 两两覆盖，靠真人失败回灌生长、按真人频率重配比。",
      cost: "需持续回灌运营 → 用台账 / 看板管理；回灌要抽象（一句失败升维成一类攻击），新攻击进 holdout。" },
    { icon: "👥", lane: "actor", title: "参与方提示词（侦探 / 填充 / 裁判）",
      one: "在沙盒里扮演对手与评委，构成可控、像真人的对局环境。",
      contract: "侦探（normal/hard 两档 ×4 人设）、填充（低参与讨论 + 共识跟随投票 rule）、裁判（盲测可疑度 + 诊断评分两套 prompt）。",
      why: "filler 用「共识跟随投票（rule）」——跟票放大已有怀疑、不注入噪声，又模拟「不上心真人」并给 AI 掩护；侦探守反指纹纪律 + 强弱档，保证既够像真人又够强。",
      cost: "侦探太弱 / 太像机器会让沙盒虚高 → 侦探多样性 + 真人校准；filler 需保证侦探占多数，别没人真抓。" },
    { icon: "🧪", lane: "offline", title: "对照测试 / 优化器自检",
      one: "流水线自检工具（非生产模块、不入闭环），只验机器不验 AI。",
      contract: "① 评估链对照：负 / 正 / 空三对照在冻结评测集上验「引擎→裁判→聚合→闸门」判得对；② 优化器自检（零对局）：挖坑 → 真优化器 → 子代是否覆盖坑。",
      why: "对照验「好编辑 ⇒ 被 credit」，自检验「优化器 ⇒ 好编辑」，组合即优化器有效性；空对照确保噪声不被当信号。",
      cost: "仅在上线 / 改动流水线后跑，不进代际闭环。" },
  ];

  /* ---------- 流水线产物标签 ---------- */
  const PIPE_OUT = {
    s0: "产物 → Scenario（输入契约）",
    s1: "产物 → MatchRecord（可复现转录）",
    s2: "产物 → ScoreRecord",
    s3: "产物 → 验证 / 瞄准信号 · 失败案例",
    s4: "产物 → k 个子版本提示词",
    s5: "产物 → 新 champion → 上线",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ============== 注入：九条洞察卡片 ============== */
  function buildInsights() {
    const grid = $("#insightGrid");
    if (!grid) return;
    INSIGHTS.forEach((it, i) => {
      const card = document.createElement("div");
      card.className = "insight-card";
      card.innerHTML =
        `<div class="ic-num">${String(i + 1).padStart(2, "0")}</div>` +
        `<p class="ic-front">${it.f}</p>` +
        `<div class="ic-back">${it.b}</div>` +
        `<span class="ic-arrow">所以呢 ↓</span>`;
      card.addEventListener("click", () => {
        const open = card.classList.toggle("open");
        card.querySelector(".ic-arrow").textContent = open ? "收起 ↑" : "所以呢 ↓";
      });
      grid.appendChild(card);
    });
  }

  /* ============== 注入：模块深潜折叠卡 ============== */
  function buildModules() {
    const list = $("#moduleList");
    if (!list) return;
    MODULES.forEach((m) => {
      const item = document.createElement("div");
      item.className = `module-item lane-${m.lane}`;
      item.innerHTML =
        `<div class="module-head">
           <div class="m-icon">${m.icon}</div>
           <div>
             <div class="m-title">${m.title}</div>
             <div class="m-one">${m.one}</div>
           </div>
           <div class="m-toggle">+</div>
         </div>
         <div class="module-body"><div class="module-body-inner">
           <div class="m-row"><span class="m-k">是什么</span><span class="m-v">${m.one}</span></div>
           <div class="m-row"><span class="m-k">关键契约</span><span class="m-v">${m.contract}</span></div>
           <div class="m-row why"><span class="m-k">为什么</span><span class="m-v">${m.why}</span></div>
           <div class="m-row cost"><span class="m-k">代价/缓解</span><span class="m-v">${m.cost}</span></div>
         </div></div>`;
      item.querySelector(".module-head").addEventListener("click", () => {
        item.classList.toggle("open"); // CSS 旋转 .m-toggle 表示展开/收起
      });
      list.appendChild(item);
    });
  }

  /* ============== scrollytelling 引擎 ============== */
  function applyTargets(graphic, targets) {
    const nodes = $$("[data-node]", graphic);
    if (targets.includes("all")) {
      nodes.forEach((n) => { n.classList.remove("is-dim"); n.classList.add("is-active"); });
    } else {
      nodes.forEach((n) => {
        const hit = targets.includes(n.getAttribute("data-node"));
        n.classList.toggle("is-dim", !hit);
        n.classList.toggle("is-active", hit);
      });
    }
    // 流水线：移动小车 + 更新产物标签
    const pipeSvg = $(".diagram-pipe", graphic);
    if (pipeSvg && targets.length && targets[0] !== "all") {
      const id = targets[0];
      const rect = $(`[data-node="${id}"] rect`, pipeSvg);
      const label = $("#pipeOutLabel", pipeSvg);
      const token = $("#pipeToken", pipeSvg);
      if (rect && token) {
        const tx = parseFloat(rect.getAttribute("x")) + 34;
        const ty = parseFloat(rect.getAttribute("y")) + 34;
        token.setAttribute("transform", `translate(${tx}, ${ty})`);
        if (label) label.textContent = PIPE_OUT[id] || "";
      }
    }
  }

  function initScrolly() {
    const groups = $$(".scrolly")
      .map((section) => ({
        section,
        graphic: $(".scrolly-graphic", section),
        stepsWrap: $(".scrolly-steps", section),
        steps: $$(".scrolly-step", section),
        tailShift: 0,
      }))
      .filter((g) => g.graphic && g.steps.length);
    if (!groups.length) return;

    const syncInitialOffsets = () => {
      groups.forEach((g) => {
        if (!g.stepsWrap) return;
        const first = g.steps[0];
        const offset = Math.max(0, (g.graphic.offsetHeight - first.offsetHeight) / 2);
        g.stepsWrap.style.setProperty("--scrolly-steps-top", `${Math.round(offset)}px`);
      });
    };

    const activate = (g, step) => {
      if (g.graphic.__active === step) return; // 没变就不重复切
      g.graphic.__active = step;
      g.steps.forEach((s) => s.classList.toggle("is-active", s === step));
      const targets = (step.getAttribute("data-target") || "").trim().split(/\s+/);
      applyTargets(g.graphic, targets);
    };

    // 初始：各组第一步高亮
    groups.forEach((g) => activate(g, g.steps[0]));
    syncInitialOffsets();

    // 滚动时：激活「卡片上沿已越过左侧图卡中心线」的最后一张卡片
    let ticking = false;
    const update = () => {
      ticking = false;
      groups.forEach((g) => {
        const graphicRect = g.graphic.getBoundingClientRect();
        const graphicCenterY = graphicRect.top + graphicRect.height / 2 + g.tailShift;
        const last = g.steps[g.steps.length - 1];
        const lastRect = last.getBoundingClientRect();
        const lastCenterY = lastRect.top + lastRect.height / 2;
        const tailShift = Math.round(Math.max(0, graphicCenterY - lastCenterY));
        g.tailShift = tailShift;
        g.section.style.setProperty("--scrolly-tail-shift", `${tailShift}px`);
        g.section.classList.toggle("is-scrolly-tail", tailShift > 0);

        let active = g.steps[0];
        for (const s of g.steps) {
          const r = s.getBoundingClientRect();
          if (r.top <= graphicCenterY) active = s;
          else break;
        }
        activate(g, active);
      });
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", () => {
      syncInitialOffsets();
      onScroll();
    });
    update();
  }

  /* ============== 顶部进度条 + 导航高亮 + 回到顶部 ============== */
  function initChrome() {
    const bar = $("#progressBar");
    const toTop = $("#toTop");
    const navLinks = $$(".topnav a");
    const sections = navLinks
      .map((a) => $(a.getAttribute("href")))
      .filter(Boolean);

    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      const p = max > 0 ? (h.scrollTop / max) * 100 : 0;
      if (bar) bar.style.width = p + "%";
      if (toTop) toTop.classList.toggle("show", h.scrollTop > 600);

      // 高亮当前 section
      const mid = window.scrollY + window.innerHeight * 0.35;
      let current = sections[0];
      sections.forEach((sec) => { if (sec.offsetTop <= mid) current = sec; });
      navLinks.forEach((a) =>
        a.classList.toggle("active", current && a.getAttribute("href") === "#" + current.id)
      );
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if (toTop) toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  /* ============== 棘轮 + reveal 动画 ============== */
  function buildRatchetTeeth() {
    const g = $("#ratchet .teeth");
    if (!g) return;
    const cx = 70, cy = 70, r1 = 46, r2 = 53, n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a);
      const x2 = cx + r2 * Math.cos(a), y2 = cy + r2 * Math.sin(a);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1.toFixed(1)); line.setAttribute("y1", y1.toFixed(1));
      line.setAttribute("x2", x2.toFixed(1)); line.setAttribute("y2", y2.toFixed(1));
      g.appendChild(line);
    }
  }

  function initReveals() {
    const wheel = $(".ratchet-wheel");
    let turn = 0;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("in");
          // 每张闸卡进场，棘轮转一齿（30°），只进不退
          if (e.target.classList.contains("gate-card") && wheel) {
            turn += 30;
            wheel.style.transform = `rotate(${turn}deg)`;
          }
          io.unobserve(e.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.2 }
    );
    $$(".reveal").forEach((el) => io.observe(el));
  }

  /* ============== 启动 ============== */
  document.addEventListener("DOMContentLoaded", () => {
    buildInsights();
    buildModules();
    buildRatchetTeeth();
    initScrolly();
    initChrome();
    initReveals();
  });
})();
