+++
title = "Ballista 分布式查询引擎 - 集群共享状态"
date = 2024-04-24
+++

集群共享状态会被存储在共享 kv 中，被所有 Scheduler 节点读写。

```rust
/// 集群节点状态
#[tonic::async_trait]
pub trait ClusterState: Send + Sync + 'static {
    /// 启动时初始化
    async fn init(&self) -> Result<()> {
        Ok(())
    }

    /// 将可执行的 tasks 分配到对应的 executor 计算资源槽上
    async fn bind_schedulable_tasks(
        &self,
        distribution: TaskDistributionPolicy,
        active_jobs: Arc<HashMap<String, JobInfoCache>>,
        executors: Option<HashSet<String>>,
    ) -> Result<Vec<BoundTask>>;

    /// 解绑 tasks，释放 executor 计算资源
    async fn unbind_tasks(&self, executor_slots: Vec<ExecutorSlot>) -> Result<()>;

    /// 注册 executor
    async fn register_executor(&self, metadata: ExecutorMetadata, spec: ExecutorData)
        -> Result<()>;

    /// 保存 executor 元信息
    async fn save_executor_metadata(&self, metadata: ExecutorMetadata) -> Result<()>;

    /// 读取 executor 元信息
    async fn get_executor_metadata(&self, executor_id: &str) -> Result<ExecutorMetadata>;

    /// 保存 executor 最新心跳信息
    async fn save_executor_heartbeat(&self, heartbeat: ExecutorHeartbeat) -> Result<()>;

    /// 从集群中移除 executor 
    async fn remove_executor(&self, executor_id: &str) -> Result<()>;

    /// 返回所有活跃 executor 的最新心跳信息
    fn executor_heartbeats(&self) -> HashMap<String, ExecutorHeartbeat>;

    /// 读取 executor 最新心跳信息
    fn get_executor_heartbeat(&self, executor_id: &str) -> Option<ExecutorHeartbeat>;
}


/// 集群作业状态
#[tonic::async_trait]
pub trait JobState: Send + Sync {
    /// 接收作业进本地队列（并没有存储在共享 kv 中）
    fn accept_job(&self, job_id: &str, queued_at: u64) -> Result<()>;

    /// 提交作业
    async fn submit_job(&self, job_id: String, graph: &ExecutionGraph) -> Result<()>;

    /// 获取所有活跃 job id
    async fn get_jobs(&self) -> Result<HashSet<String>>;

    /// 获取作业状态
    async fn get_job_status(&self, job_id: &str) -> Result<Option<JobStatus>>;

    /// 获取作业的执行图（分布式执行计划）
    async fn get_execution_graph(&self, job_id: &str) -> Result<Option<ExecutionGraph>>;

    /// 保存作业执行图状态
    async fn save_job(&self, job_id: &str, graph: &ExecutionGraph) -> Result<()>;

    /// 标记作业失败（planning阶段失败）
    async fn fail_unscheduled_job(&self, job_id: &str, reason: String) -> Result<()>;

    /// 移除作业
    async fn remove_job(&self, job_id: &str) -> Result<()>;

    /// 读取会话
    async fn get_session(&self, session_id: &str) -> Result<Arc<SessionContext>>;

    /// 创建一个会话
    async fn create_session(&self, config: &BallistaConfig) -> Result<Arc<SessionContext>>;
}
```

**Executor 元信息**

主要包括 Executor 的 id、ip 和 端口等信息。在 Executor 节点启动时，会往 Scheduler 注册，Scheduler 会将 Executor 元信息存储到共享 kv 中。

**Executor 心跳信息**

主要包括 Executor 的 id、此次心跳时间戳 和 executor 状态。
1. 在 Executor 启动注册时，会往共享 kv 中存入心跳信息
2. 在 Executor 定时发送心跳时，会往共享 kv 中覆盖心跳信息
3. 在检查 Executor 心跳是否过期的定时任务中，会移除共享 kv 中过期的 Executor 的心跳信息

**Executor 资源信息**

主要包括 Executor 还有多少计算资源（一个任务执行占据一个资源槽位）。
1. 在注册 executor 时，会增加资源槽位总量
2. 在分配可执行 tasks 到 executor 时，会消耗资源槽位
3. 在 tasks 执行完毕时，释放资源槽位

**会话信息**

会话信息主要包括作业配置（如配置多少并行度），Client 连接 Scheduler 时，会创建一个会话并存储在共享 kv 中。

**作业执行图（分布式执行计划）**

主要包括整个分布式执行计划，以及每个 stage 的执行状态。
1. 在提交作业时，会将整个执行图保存到共享 kv 中
2. 在作业执行成功/终止作业/作业执行有更新时，会更新整个执行图到共享 kv 中
3. 在作业执行完毕后，会从共享 kv 中移除

**作业状态**

作业状态因为读取频繁，被额外单独存储（作业状态可以从执行图中获取）。
1. 在提交作业时，会将作业状态保存到共享 kv 中
2. 在作业执行成功/终止作业/作业执行有更新时，会更新作业状态到共享 kv 中
3. 在作业执行完毕后，会从共享 kv 中移除