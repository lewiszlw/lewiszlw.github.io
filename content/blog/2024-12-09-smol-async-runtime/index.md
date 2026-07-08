+++
title = "Rust 异步运行时 smol 剖析"
date = 2024-12-09
+++

[smol] 是一个小型且快速的 Rust 异步运行时，它由许多小型的 crate 组成（比如 polling / async-io / async-executor 等），每个 crate 相对独立，非常适合学习 Rust 异步运行时是如何一步步构建的。

## crates 概览
![](./smol-crates-overview.drawio.png)

核心基础库
- [polling] 提供一个在 epoll / kqueue / iocp 等之上统一的 IO 多路复用的接口
- [async-io] 实现 reactor 和 driver 底层机制并对外提供 `Async` 和 `Timer` 两个工具来实现异步 IO 和定时器
- [blocking] 提供用于在异步环境中隔离同步 IO 操作的线程池
- [async-task] 提供异步任务的抽象封装，便于构建自己的 executor

面向用户的上层库
- [async-net] 基于 async-io 的 Async 工具对标准库 `std::net` 的封装
- [async-process] 基于 async-io（Unix-like 系统）和 blocking（Windows 系统）对标准库 `std::process` 的封装
- [async-fs] 基于 blocking 对标准库 `std::fs` 的封装
- [async-executor] 提供单线程和多线程两种 executor

工具库
- [async-channel] 提供异步的多生产者多消费者队列
- [async-lock] 提供异步环境的同步原语，如互斥锁、读写锁等等

本文主要学习 polling / async-io / async-task / async-executor 库，理解最重要的 IO 多路复用 / reactor / driver / task / executor 等概念。

## polling

polling 对 epoll / kqueue / iocp 等各平台的 IO 多路复用机制进行了一个统一的抽象，方便跨平台使用。

它提供了一个 `Poller` 结构体，封装了各平台的 IO 多路复用机制（例如 Linux 下则包含 [epoll_create1] 返回的文件描述符），并主要提供了三个方法
1. 增删改感兴趣的 IO 事件（参考 [epoll_ctl](https://man7.org/linux/man-pages/man2/epoll_ctl.2.html)）
2. 阻塞等待新的 IO 事件（参考 [epoll_wait]）
3. 唤醒正在阻塞等待中的自身

以 Linux 下 epoll 为例分析其细节，
1. 创建 Poller 时，调用 [epoll_create1] 创建一个新的 epoll 实例并保存到 Poller 中，同时往 epoll 列表中注册两个 IO 源
    - 调用 [eventfd](https://man7.org/linux/man-pages/man2/eventfd.2.html) 创建用于通知（唤醒）的对象 notifier
    - 调用 [timerfd_create](https://man7.org/linux/man-pages/man2/timerfd_create.2.html) 创建的定时器
2. 增删改感兴趣的 IO 事件时，传入其所属的文件描述符（例如 socket），关联数据（当返回 IO 事件时携带），以及一些标志位（比如只监听可读或可写事件）
3. 阻塞等待新的 IO 事件时，可传入超时时间，当有新的 IO 事件（一个或多个） / 中断 / 超时，结束阻塞返回。这里并没有使用 [epoll_wait] 本身的超时机制，而是使用更为精确的定时器，在调用 [epoll_wait] 前会通过 [timerfd_settime](https://man7.org/linux/man-pages/man2/timerfd_settime.2.html) 设置定时器超时时间，当超时时间到达时，会在 timer 文件描述符上产生一个新的 IO 事件来结束阻塞
4. 唤醒正在阻塞等待中的自身时，通过调用 [write](https://man7.org/linux/man-pages/man2/write.2.html) 往 notifier 文件描述符上写入数据来触发一个新的 IO 事件来结束阻塞

具体例子
```rust
// 创建一个 socket
let socket = TcpListener::bind("127.0.0.1:8000")?;
socket.set_nonblocking(true)?;

// 指定 socket 标识符（epoll 返回新的 IO 事件时会携带）
let key = 7;

// 创建一个 epoll 实例，并执行初始化工作（注册 notifier 和 timer 到 epoll 列表中）
let poller = Poller::new()?;

// 将 socket 添加到 epoll 队列中，监听其可读事件
unsafe {
    poller.add(&socket, Event::readable(key))?;
}

let mut events = Events::new();
loop {
    events.clear();

    // 阻塞等待新的 IO 事件（这里并未传入超时时间）
    poller.wait(&mut events, None)?;

    for ev in events.iter() {
        // 如果发现 socket 可读事件，则执行下一步操作
        if ev.key == key {
            socket.accept()?;
            // 继续监听 socket 可读事件
            poller.modify(&socket, Event::readable(key))?;
        }
    }
}

// 在 socket drop 前必须要将其从 epoll 列表中移除
poller.delete(&socket)?;
```

## async-io

async-io 提供了一个全局唯一的 Reactor 实例来支持对定时器 Timer 和 IO 对象的事件监听，它利用了 polling 提供的 IO 多路复用抽象。Reactor 并不会主动去轮询监听新事件，而是需要一个 Driver 来进行驱动，Driver 实际上就是一个独立的 OS 线程，它会一直循环不断的驱动 Reactor。

在 Reactor 之上提供了两个面向用户的工具：
- Async：用于构建异步 IO 的适配器，用户使用它来包装同步 IO 类型（如 `std::net::TcpStream`），然后提供异步的 IO 读写能力
- Timer: 用户可以创建一个 Timer 来周期性的发出事件，Timer 实现了 `Future` 和 `Stream` trait，用户可以对它进行 `poll` 或 `poll_next`

**Reactor**

Reactor 提供了 `insert_io` / `remove_io` / `insert_timer` / `remove_timer` 方法来向 Reactor （取消）注册 IO 对象或者定时器，对于 IO 对象，会（取消）注册到底层 OS 的 IO 多路复用机制上（如 epoll）。

```rust
/// IO 源
#[derive(Debug)]
pub(crate) struct Source {
    /// IO 文件描述符
    registration: Registration,

    /// IO 源的 ID，注册到 epoll 时携带，用它来区分 IO 事件来自哪个 IO 源
    key: usize,

    /// IO 源的读端和写端的状态，和监听它的 wakers
    state: Mutex<[Direction; 2]>,
}
```
Reactor 将 IO 源封装为一个 `Source` 结构，上层持有 `Source` 可以进行 poll，如果 IO 源 ready 则返回 `Poll::Ready`，否则 Reactor 会保存 waker 并返回 `Poll::Pending`。一个 IO 源可以被多个 wakers 来监听。

Reactor 的核心是 `fn react(&mut self, timeout: Option<Duration>) -> io::Result<()>` 方法，它会阻塞线程直到有新的 IO / timer 事件（如果传入了超时时间则可能超时返回），当收到新的事件后，通过 poll 传递下来的 waker 来进行唤醒。它通过 Mutex 被限制为只能有一个线程来执行，无法并发执行。

Reactor 通过 tick 机制来保证 IO 事件是否是“新鲜的”，在每轮 `react` 方法执行期间，tick 值都会自增 1。

**Driver**

因为 epoll 的模型就是需要用户去轮询，它不会主动推送 IO 事件，所以我们需要 Driver 来驱动。Driver 是一个单独的 OS 线程，在 Reactor 初始化时一并创建。它不断循环的去尝试获取 Reactor 锁并执行其 `react` 方法，然后 `react` 方法会阻塞 Driver 线程直至有新的 timer / IO 事件产生。

**Async**

Async 的原理是通过异步机制监控 IO 源是否 ready，对其进行 poll 的结果是 IO 源是否可读或可写，而不是读取或写入数据到 IO 源。所以当我们需要执行同步 IO 操作时，先让 Async 监控 IO 源是否 ready，当 IO 源 ready 了再执行同步 IO 操作，这时就不会发生 IO 阻塞线程了。

```rust
async fn my_server() -> std::io::Result<()> {
    let listener = Async::new(std::net::TcpListener::bind("127.0.0.1:8080")?)?;
    loop {
        let (_stream, addr) = listener.read_with(|io: &std::net::TcpListener| io.accept()).await?;
        println!("Accepted connection from: {}", addr);
    }
}
```
以上示例创建了一个同步的 `std::net::TcpListener` 并用 Async 包装起来，然后就可以异步地监听新连接。其过程是
1. `std::net::TcpListener` 实现了 `AsFd` trait，Async 获取其 IO 文件描述符
2. 通过 [fcntl](https://man7.org/linux/man-pages/man2/fcntl.2.html) 系统调用将其设置为非阻塞 IO
3. 然后 IO 对象注册到 Reactor 中，获取其 `Source` 引用
4. 在 Async 被 poll 时，会通过其内部持有的 `Source` 来执行 poll，此时 IO 源未 ready，则 Reactor 会保存其 waker，返回 `Poll::Pending`
5. 等到有新的 IO 事件时，Reactor 再通过 waker 通知
6. Async 被再次 poll，此时 IO 源 ready，返回 `Poll::Ready(Ok(()))`
7. 然后再执行 `std::net::TcpListener::accept` 同步方法，此时执行 accept 不会阻塞，而是会立刻返回

## async-task

async-task 提供了异步任务的抽象封装，异步任务 RawTask 包含 future 以及 future 运行时所需的内容，基于 RawTask 对外提供了两个安全的封装 Runnable 和 Task。Runnable 主要给上层 Executor 使用，Executor 可以使用 Runnable 触发一次调度或者执行一次 poll。Task 主要面向用户使用，用户可以 await Task，也可以取消 Task 或者让 Task 后台运行。

![](./async-task-layout.drawio.png)

以上是 RawTask 的内存布局，包含：
- `state`: 任务状态
- `awaiter`: 用户 poll Task 时注册的 waker
- `vtable`: 指向一个静态变量，包含各种函数指针
  - `schedule`: 实际会调用 custom_schedule
  - `drop_future`: 析构 future
  - `get_output`: 读取 future 结果
  - `drop_ref`: 减少任务引用计数，当引用计数归零时，调用 destroy 销毁任务
  - `destroy`: 清理任务的资源和内存
  - `run`: 执行异步任务
  - `clone_waker`: 克隆一个新的 waker
- `metadata`: Executor 传入的自定义数据
- `custom_schedule`: Executor 传入的调度方法，RawTask 使用它来向 Executor 触发一次调度
- `future` / `output`: 一块 union 区域，存放 future 或者其结果 output

其中 `clone_waker`、`wake`、`wake_by_ref` 和 `drop_waker` 组成了标准库 [RawWakerVTable](https://doc.rust-lang.org/std/task/struct.RawWakerVTable.html) 的四个方法。

RawTask 内包含一套引用计数机制，Runnable、Task 和 Waker 都持有对 RawTask 的引用，当引用计数归零时，就会执行 `destroy` 方法清理 RawTask 资源和内存。

任务主要有以下状态：
1. `scheduled`: 即将被调度执行
2. `running`: 正在执行 poll
3. `completed`: 任务完成（output 还没被读取）
4. `closed`: 任务关闭（任务被取消或者 output 已被读取）

**创建异步任务**

创建异步任务 `fn spawn<F, S>(future: F, schedule: S) -> (Runnable, Task<F::Output>)` 需要传入 future 和 custom_schedule 方法，任务初始状态为 `scheduled`，返回 Runnable 和 Task。

**Runnable**
- `schedule` 方法：用于让 Executor 调度该任务，此方法仅调用 `custom_schedule` 方法，无其他行为
- `run` 方法：实际调用 `RawTask::run` 方法，用于让 Executor 对任务执行 poll 操作，如果任务执行完毕，则将状态改为 `completed`。如果任务是 `closed` 状态，会执行资源清理动作

**Task**
- `poll_task` 方法：如果任务未完成，则注册 waker 并返回 `Poll::Pending`；如果任务完成了，则读取 output 并将任务置为 `closed` 状态
- `cancel` 方法：通过将任务置为 `closed` 状态，会重新发起一次调度，在执行任务过程中进行后续资源清理动作
- `detach` 方法：通过 `mem::forget` 来不 drop Task，将任务置于后台运行，运行结束后直接将任务置为 `closed` 状态

**Waker**: 异步任务内部管理的用于传递给 Reactor 的 waker，当 IO 源 ready 时唤醒异步任务并触发一次调度，一个异步任务可以有多个 IO 源，所以也会有多个 waker
- `clone_waker`: 调用 `RawWaker::clone_waker` 克隆一个新的 waker
- `wake`: 通过将任务设置为 `scheduled` 状态并触发一次调度，清理 waker 关联资源
- `wake_by_ref`: 通过将任务设置为 `scheduled` 状态并触发一次调度
- `drop_waker`: 减少任务引用计数

**Awaiter**：用户 await Task （如通过 block_on）时传入的 waker，当异步任务完成时唤醒用户再次 poll 获取 future 结果，一个异步任务对应至多一个 Awaiter（当任务后台运行时则没有）

## async-executor

async-executor 提供了两个简单的 executor 用于执行用户异步任务。
- Executor：实现了 Send + Sync，支持多线程，spawn 方法限制 future 需要实现 Send
- LocalExecutor：对 Executor 的包装，未实现 Send + Sync，限定单线程，spawn 方法不需要 future 实现 Send

核心数据结构为
```rust
struct State {
    /// 全局队列
    queue: ConcurrentQueue<Runnable>,

    /// 本地队列
    local_queues: RwLock<Vec<Arc<ConcurrentQueue<Runnable>>>>,

    /// 是否已通知 sleeper（不重复通知）
    notified: AtomicBool,

    /// 等待全局队列新增任务（全局队列为空）
    sleepers: Mutex<Sleepers>,

    /// 当前活跃任务（通过持有 Waker 保持任务引用计数不归零）
    active: Mutex<Slab<Waker>>,
}
```

- 调度任务（custom_schedule）：通过将任务加入到全局队列中，并通知 sleeper。
- 执行任务：从队列获取一个任务，调用 `Runnable::run` 方法对 future 执行一次 poll。

有两种驱动 executor 的方法：
1. tick：从全局队列选取一个任务来执行 poll，当全局队列无任务时，注册一个 sleeper 等待
2. run：传入一个 future，运行该 future 直至完成，在运行该 future 同时会运行所属本地队列的其他任务，如果本地队列为空会从全局队列窃取任务，如果全局队列为空会从其他本地队列窃取任务，如果都没有则注册一个 sleeper 等待

## 实现一个多线程异步运行时
```rust
fn main() {
    let ex = Executor::new();

    thread::scope(|scope| {
        for _ in 0..5 {
            scope.spawn(|| block_on(ex.run(core::future::pending::<()>())));
        }

        block_on(async {
            let listener = TcpListener::bind("127.0.0.1:8080").await.unwrap();
            loop {
                let (stream, addr) = listener.accept().await.unwrap();
                let task = ex.spawn(handle_new_connection(stream, addr));
                task.detach();
            }
        })
    })
}

async fn handle_new_connection(_stream: TcpStream, addr: SocketAddr) {
    Timer::after(Duration::from_secs(10)).await;
    println!(
        "[{:?}] Handle connection from: {}",
        thread::current().id(),
        addr
    );
}

// 类似于 tokio 以下代码
#[tokio::main]
async fn main() {
    let listener = TcpListener::bind("127.0.0.1:8080").await.unwrap();

    loop {
        let (stream, addr) = listener.accept().await.unwrap();
        tokio::spawn(handle_new_connection(stream, addr));
    }
}
```
由于 Executor 非 static 生命周期，因此采用 Scoped threads 实现多线程，主线程负责监听端口获取新连接，并创建一个后台任务处理，子线程负责从本地队列（会从全局队列或其他本地队列窃取任务）读取任务进行执行。



[smol]: https://github.com/smol-rs/smol
[polling]: https://github.com/smol-rs/polling
[blocking]: https://github.com/smol-rs/blocking
[parking]: https://github.com/smol-rs/parking
[async-lock]: https://github.com/smol-rs/async-lock
[async-channel]: https://github.com/smol-rs/async-channel
[async-task]: https://github.com/smol-rs/async-task
[async-io]: https://github.com/smol-rs/async-io
[async-fs]: https://github.com/smol-rs/async-fs
[async-process]: https://github.com/smol-rs/async-process
[async-executor]: https://github.com/smol-rs/async-executor
[async-net]: https://github.com/smol-rs/async-net
[epoll_create1]: https://man7.org/linux/man-pages/man2/epoll_create.2.html
[epoll_wait]: https://man7.org/linux/man-pages/man2/epoll_wait.2.html
