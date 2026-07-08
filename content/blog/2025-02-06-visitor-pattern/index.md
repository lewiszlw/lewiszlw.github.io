+++
title = "Visitor 模式的两种不同实现分析"
date = 2025-02-06
+++

Visitor 模式常用于 AST（抽象语法树）之类的树形结构的遍历和改写，例如遍历 SQL AST 以确定其将访问哪些表、对 AST 中某些表达式进行简化等等。

Visitor 模式通常提供一个 `Visitor` trait 和一个接收 Visitor 实例的 `walk` 函数或者方法，用户通过实现 `Visitor` trait 来定义自己的 Visitor，然后通过执行 `walk` 函数或者方法（会将自定义的 Visitor 实例传入）来对整个树形结构进行遍历。

Visitor 模式在 [databend]、[iceberg-rust] 和 [datafusion-sqlparser-rs] 等项目中有着不同的实现方式，我们以 SQL AST 为例来分析几种不同的 Visitor 模式实现。

## 实现一：手工实现

老版本的 [databend](https://github.com/systemxlabs/databend-parser) 和 [iceberg-rust] 是采用手工实现，通过手写代码进行递归遍历，若 AST 中新增类型则需要手动添加新类型的递归逻辑。

老版本的 databend 和 iceberg-rust 的实现略有区别，主要在于递归逻辑的位置，一个是放在 `Visitor` trait 中，由用户来控制如何递归，更灵活也更繁琐，一个是放在 `walk` 函数中，递归逻辑已经提前写好，用户无需关心但不够灵活。

以老版本的 databend 为例

定义 `Visitor` trait（每新增一种表达式，就需要在 `Visitor` trait 中新增一种对应方法）
```rust
pub trait Visitor {
    fn visit_column_ref(
        &mut self,
        database: &Option<Identifier>,
        table: &Option<Identifier>,
        column: &ColumnID,
    );
    fn visit_is_null(&mut self, expr: &Expr, not: bool);
    fn visit_in_list(&mut self, expr: &Expr, list: &[Expr], not: bool);
    ...
}
```

定义 `walk` 函数（每新增一种表达式，就需要在 `walk` 函数中新增一个 match arm，`walk` 函数比较简单，无需处理递归逻辑）
```rust
pub fn walk_expr<V: Visitor>(visitor: &mut V, expr: &Expr) {
    match expr {
        Expr::ColumnRef {
            database,
            table,
            column,
        } => visitor.visit_column_ref(database, table, column),
        Expr::IsNull { expr, not } => visitor.visit_is_null(expr, *not),
        Expr::InList {
            expr,
            list,
            not,
        } => visitor.visit_in_list(expr, list, *not),
        ...
    }
}
```

用户自定义 Visitor（自己处理递归）
```rust
pub struct ColumnCounter {
    count: usize,
}

impl Visitor for ColumnCounter {
    fn visit_column_ref(&mut self, _: &Option<Identifier>, _: &Option<Identifier>, _: &ColumnID) {
        self.count += 1;
    }
    fn visit_is_null(&mut self, expr: &Expr, not: bool) {
        walk_expr(self, expr)
    }
    fn visit_in_list(&mut self, expr: &Expr, list: &[Expr], not: bool) {
        walk_expr(self, expr)
        for expr in list {
            walk_expr(self, expr);
        }
    }
}
```

## 实现二：代码生成

新版本的 [databend] （采用的是 [derive-visitor] 库）和 [datafusion-sqlparser-rs] 是采用代码生成实现，通过派生宏给每个类型（包括 AST 类型和标准库中的类型）生成 `walk` 方法，`walk` 方法会递归遍历其内部每个元素。

定义 `Walk` trait
```rust
pub trait Walk {
    fn walk<V: Visitor>(&self, visitor: &mut V);
}
```

利用派生宏给每个 AST 类型生成 `Walk` trait 实现
```rust
#[derive(Walk)]
pub enum Expr {
    IsNull {
        expr: Box<Expr>,
        not: bool,
    }
}
```
生成代码
```rust
impl Walk for Expr {
    fn walk<V: Visitor>(&self, visitor: &mut V) {
        // 对当前类型中的每个元素递归调用 walk 方法
        match self {
            Self::IsNull { expr, not } => {
                expr.walk(visitor);
                not.walk(visitor);
            }
            _ => {}
        }
    }
}
```

下一步就是如何在 walk 遍历过程中插入对 Visitor 的调用，这也是 [derive-visitor] 和 [datafusion-sqlparser-rs] 实现的区别之处。

### derive-visitor
[derive-visitor] 采用的方式是在所有 walk 地方插入对 Visitor 的调用，Visitor 通过动态类型 `std::any::Any` 接收并在运行时判断具体类型。

[derive-visitor] 的 `Visitor` trait 只有一个方法
```rust
pub trait Visitor {
    fn visit(&mut self, item: &dyn Any, event: Event);
}
pub enum Event {
    Enter,
    Exit,
}
```

[derive-visitor] 的派生宏生成代码
```rust
impl Walk for Expr {
    fn walk<V: Visitor>(&self, visitor: &mut V) {
        // walk 前插入对 Visitor 的调用
        visitor.visit(self, Event::Enter);

        match self {
            Self::IsNull { expr, not } => {
                expr.walk(visitor);
                not.walk(visitor);
            }
            _ => {}
        }

        // walk 后插入对 Visitor 的调用
        visitor.visit(self, Event::Exit);
    }
}
```

用户在实现自己的 Visitor 时，需要手动判断 `std::any::Any` 的具体类型
```rust
pub struct ColumnCounter {
    count: usize,
}

impl Visitor for ColumnCounter {
    fn visit(&mut self, item: &dyn Any, event: Event) {
        // 通过 Any 的 downcast 方法判断具体类型
        if let Some(item) = <dyn ::std::any::Any>::downcast_ref::<ColumnRef>(item) {
            match event {
                Event::Enter => { self.count += 1; }
                _ => {}
            }
        }
    }
}
```

### datafusion-sqlparser-rs

[datafusion-sqlparser-rs] 采用的方式是通过属性宏指定在某些 walk 地方插入对 Visitor 的调用。

```rust
#[derive(Walk)]
#[walk(with = "visit_expr")]
pub enum Expr { ... }
```

生成代码
```rust
impl Walk for Expr {
    fn walk<V: Visitor>(&self, visitor: &mut V) {
        // walk 前插入对 Visitor 的调用
        visitor.pre_visit_expr(self);

        match self {
            Self::IsNull { expr, not } => {
                expr.walk(visitor);
                not.walk(visitor);
            }
            _ => {}
        }

        // walk 后插入对 Visitor 的调用
        visitor.post_visit_expr(self);
    }
}
```

[databend]: https://github.com/databendlabs/databend
[iceberg-rust]: https://github.com/apache/iceberg-rust
[datafusion-sqlparser-rs]: https://github.com/apache/datafusion-sqlparser-rs
[derive-visitor]: https://crates.io/crates/derive-visitor
