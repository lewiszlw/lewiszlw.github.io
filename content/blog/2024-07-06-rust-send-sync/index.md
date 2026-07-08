+++
title = "Rust 无畏并发的基础 Send 和 Sync"
date = 2024-07-06
+++

## 线程不安全的原因
1. 数据竞争，是指多个线程在同一时刻对同一个数据进行读写或者写写。
2. 数据的某些操作跟特定线程绑定在一起。比如 [pthread_mutex_lock](https://pubs.opengroup.org/onlinepubs/009695399/functions/pthread_mutex_lock.html) 的 unlock 操作必须在其 lock 线程执行，否则会 [undefined behavior](https://en.wikipedia.org/wiki/Undefined_behavior)，比如窗口管理 winit 中的 EventLoop 必须在主线程创建和执行。

## Send 和 Sync 定义
**[Send](https://doc.rust-lang.org/std/marker/trait.Send.html)：Types that can be transferred across thread boundaries**

类型可以在线程间安全地被复制或着移动。
- 几乎所有 [primitives 类型]都是 Send，比如 bool、i32、array等，而裸指针 [pointer](https://doc.rust-lang.org/std/primitive.pointer.html) 类型并不是
- `unsafe impl<T: Sync + ?Sized> Send for &T {}` 表示如果 T 是 Sync，其不可变引用 &T 可以复制到其他线程被安全地使用

**[Sync](https://doc.rust-lang.org/std/marker/trait.Sync.html)：Types for which it is safe to share references between threads**

类型可以在线程间安全地共享引用。
- 这里共享的引用指 &T，因为 &mut T 天然地被 Rust 借用规则限制，不可能两个线程同时拥有 &mut T
- 由于 Rust 的[内部可变性模式](https://doc.rust-lang.org/reference/interior-mutability.html)，&T 并不能保证只读数据，因此 Sync 解决的问题就是 &T 跨线程的安全性
- 不具有内部可变性的类型，其引用 &T 只读数据，因此 T 可以跨线程共享引用，满足 Sync
  - 几乎所有 [primitives 类型]都是 Sync，比如 bool、i32、array等，而裸指针 [pointer](https://doc.rust-lang.org/std/primitive.pointer.html) 类型并不是
  - 基于以上 primitives 的 struct、tuple 和 enum 也都会自动实现 Sync
- 内部可变性原语 UnsafeCell 不是 Sync
  - 在其上没有通过同步机制构建的类型（比如 Rc 和 RefCell）也不是 Sync
  - 在其上通过同步机制构建的类型（比如 AtomicBool、Arc、Mutex 等）则可以是 Sync

Send 和 Sync 都是 auto marker trait，编译器会自动给每个符合的类型自动实现该 trait，也可以手动通过 `impl !Send for XXX` 来显示地标识某类型不是 Send。

## 推导结论
**T: Sync <=> &T: Send**
- 如果 T 是 Sync，说明可以在线程间安全的共享引用，所以 &T 可以被安全的 Send。相反，如果 T 不是 Sync，那么其引用 &T 就不能被安全地 Send
- 如果 &T 是 Send，说明 T 的引用可以在线程间安全地发送，所以 T 是 Sync。相反，如果 &T 不能安全的 Send，那么 T 就不是 Sync

**T: Sync <=> &T: Sync**
- T 是 Sync，所以 &T 是 Send。&T 是 Sync 的前提是 &&T 为 Send，而 &&T 实际就是 &T（共享是可传递的），所以 &&T 也是 Send，那么 &T 则为 Sync

**T: Sync <=> &mut T: Sync**
- T 是 Sync，所以 &T 是 Send。&mut T 是 Sync 的前提是 &&mut T 为 Send，而 &&mut T 实际就是 &T，所以 &&mut T 也是 Send，那么 &mut T 则为 Sync

**T: Send <=> &mut T: Send**
- &mut T 某种程度可以看作拥有 T 的所有权（只不过它不能将 T 完全 drop，需要保证引用在其生命周期内有效），因为 &mut T 可以通过 `*ref = T` 来覆写其整个数据（原数据被 drop），也可以通过 [std::mem::replace](https://doc.rust-lang.org/std/mem/fn.replace.html) 将其指向的原数据 move 走
- 所以 &mut T 是 Send 的前提是 T 必须可以在线程间安全地 move，即 T 为 Send

以上结论的两边都是等价的，可以互相推导。

## 实际例子
**Send + Sync**
- 绝大多数 [primitives 类型]：bool、i32、array
- Atomic* 类型：AtomicBool、AtomicI32
- 基于 Send + Sync 类型构建的 struct、tuple、enum

**Send + !Sync**
- Cell 和 RefCell，其拥有内部可变性，但并没有使用同步机制

**!Send + Sync**
- MutexGuard，必须在加锁的线程上去释放锁（发生在 drop 时），因此不能 Send 到其他线程上被 drop。MutexGuard 可以通过 DerefMut 获取 &mut T，因此当 T 是 Sync 时，MutexGuard 才是 Sync（`impl<T: ?Sized + Sync> Sync for MutexGuard<'_, T>`）

**!Send + !Sync**
- Rc，其内部引用计数非原子更新，Rc 和 &Rc 均无法发送到其他线程，因为两者都可以通过 clone 改变内部引用计数器

**Arc**
- `unsafe impl<T: ?Sized + Sync + Send, A: Allocator + Send> Send for Arc<T, A> {}`
  - 因为 Arc 是共享所有权，因此不确定 T 最终会在哪个线程上被 drop，因此 Arc 是 Send 的前提之一是 T 是 Send
  - Arc 可以通过 Deref 拿到 &T，因此在线程间发送 Arc 等价于发送 &T，而 &T 可以被安全发送的前提是 T 必须是 Sync
- `unsafe impl<T: ?Sized + Sync + Send, A: Allocator + Sync> Sync for Arc<T, A> {}`，在线程间发送 Arc 或其引用 &Arc 本质是一样的，因为两者都可以通过 clone 拿到一个新的 Arc

**Mutex**
- `unsafe impl<T: ?Sized + Send> Send for Mutex<T> {}`，如果 T 不是 Send，那么 Mutex 被发送到其他线程后获取锁 MutexGuard，进而通过 DerefMut 获取到 &mut T，而 &mut T 可以将其原值 drop 或者 move，存在问题。因此 T 必须 Send，Mutex 才会是 Send
- `unsafe impl<T: ?Sized + Send> Sync for Mutex<T> {}`，如果 T 不是 Send，那么 Mutex 的引用被共享到其他线程后仍能获取锁 MutexGuard，进而通过 DerefMut 获取到 &mut T，而 &mut T 可以将其原值 drop 或者 move，存在问题。因此 T 必须 Send，Mutex 才会是 Sync

**RwLock**
- `unsafe impl<T: ?Sized + Send> Send for RwLock<T> {}`，如果 T 不是 Send，那么 RwLock 被发送到其他线程后获取写锁 RwLockWriteGuard，进而通过 DerefMut 获取到 &mut T，而 &mut T 可以将其原值 drop 或者 move，存在问题。因此 T 必须 Send，RwLock 才会是 Send
- `unsafe impl<T: ?Sized + Send + Sync> Sync for RwLock<T> {}`
  - 如果 T 不是 Send，那么 RwLock 的引用被共享到其他线程后仍能获取写锁 RwLockWriteGuard，进而通过 DerefMut 获取到 &mut T，而 &mut T 可以将其原值 drop 或者 move，存在问题。因此 T 必须 Send，RwLock 才会是 Sync
  - 如果 T 不是 Sync，那么 RwLock 的引用被共享到其他线程后可能多个线程同时获取到读锁 RwLockReadGuard，进而通过 Deref 获取到 &T，而 T 不是 Sync 的话，那么多线程同时使用 &T 存在问题。因此 T 必须 Sync，RwLock 才会是 Sync
- RwLock 跟 Mutex 的区别就在于其读锁可以同时获取多个进行并发地读

参考：
1. https://users.rust-lang.org/t/example-of-a-type-that-is-not-send/59835/3
2. https://doc.rust-lang.org/nomicon/send-and-sync.html
3. https://doc.rust-lang.org/std/marker/trait.Send.html
4. https://doc.rust-lang.org/std/marker/trait.Sync.html

[primitives 类型]: https://doc.rust-lang.org/std/index.html#primitives