"""Agent 编排层：LangGraph 状态机 + 工具调用 + 自建 RAG。

模块职责：
- prompts.py：电商客服 / 企业知识库两套系统提示词
- tools.py：业务工具（商品、订单、政策、优惠券、人工升级工单）
- graph.py：retrieve → agent → tools → agent 的状态机与流式事件

会话历史、额度限流、Token 记账仍在 routers/chat.py，Agent 层保持无状态，
方便同一张图被 HTTP 接口、评测脚本复用。
"""
