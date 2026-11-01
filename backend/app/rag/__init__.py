"""自建 RAG：文档解析 → 父子切片 → 向量化 → 混合检索 → 精排 → 证据链。

所有环节都在本项目内实现，不依赖 Dify：
- 解析 / 切片：parser.py、chunker.py
- 向量化 / 精排：zhipu.py（硅基流动 bge-m3 + bge-reranker，可切回智谱）
- 存储与向量检索：store.py（PostgreSQL + pgvector）
- 关键词检索：bm25.py（中文字符二元组，无需分词词典）
- 融合与父块展开：retriever.py
"""
