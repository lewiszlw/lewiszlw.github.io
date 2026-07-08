+++
title = "DataFusion 查询引擎 UDF 设计"
date = 2024-06-03
+++

UDF 是指用户自定义标量函数（Scalar User Defined Functions），函数为输入的每一行生成一行输出。DataFusion 中使用 [ScalarUDFImpl] trait 对 UDF 进行抽象，用户 UDF 只需实现该 trait 并将其注册到 SessionContext 即可使用。DataFusion 内置标量函数和用户 UDF 均使用同一套 API [ScalarUDFImpl] 实现。

```rust
// 移除了部分兼容性代码（看起来会更简洁）
pub trait ScalarUDFImpl: Debug + Send + Sync {
    fn as_any(&self) -> &dyn Any;

    fn name(&self) -> &str;

    fn aliases(&self) -> &[String] {
        &[]
    }

    fn display_name(&self, args: &[Expr]) -> Result<String> {
        let names: Vec<String> = args.iter().map(create_name).collect::<Result<_>>()?;
        Ok(format!("{}({})", self.name(), names.join(",")))
    }

    fn signature(&self) -> &Signature;

    fn return_type_from_exprs(
        &self,
        args: &[Expr],
        schema: &dyn ExprSchema,
        arg_types: &[DataType],
    ) -> Result<DataType>;

    fn invoke(&self, args: &[ColumnarValue]) -> Result<ColumnarValue>;

    fn simplify(
        &self,
        args: Vec<Expr>,
        info: &dyn SimplifyInfo,
    ) -> Result<ExprSimplifyResult> {
        Ok(ExprSimplifyResult::Original(args))
    }

    fn short_circuits(&self) -> bool {
        false
    }

    fn evaluate_bounds(&self, input: &[&Interval]) -> Result<Interval> {
        Interval::make_unbounded(&DataType::Null)
    }

    fn propagate_constraints(
        &self,
        interval: &Interval,
        inputs: &[&Interval],
    ) -> Result<Option<Vec<Interval>>> {
        Ok(Some(vec![]))
    }

    fn output_ordering(&self, inputs: &[ExprProperties]) -> Result<SortProperties> {
        Ok(SortProperties::Unordered)
    }

    fn coerce_types(&self, arg_types: &[DataType]) -> Result<Vec<DataType>> {
        not_impl_err!("Function {} does not implement coerce_types", self.name())
    }
}
```

## `fn as_any(&self) -> &dyn Any`

返回 Any 动态类型。

可以在运行时通过类型来判断函数具体是哪种，比如 `func.as_any().downcast_ref::<LogFunc>().is_some()` 来判断是否为 `LogFunc`。

## `fn name(&self) -> &str`

返回函数名称，如 `abs`。

函数名称会被作为函数唯一标识注册到 `FunctionRegistry` 中。

## `fn aliases(&self) -> &[String]`

返回函数的所有别名。

每个别名也会作为唯一标识注册 `FunctionRegistry` 中，其对应的均是同一个 UDF 实例。

## `fn display_name(&self, args: &[Expr]) -> Result<String>`

返回展示名称，包含函数名和参数，如 `abs(t1.a)`。

在打印逻辑计划、生成列名等情况均会用到。

## `fn signature(&self) -> &Signature`

返回函数入参类型和易变性（Volatility）
- 入参类型支持固定、变长参数、任意参数等等，还可以在运行时指定参数（使用 `coerce_types` 方法）
- 易变性包括三种，主要用在判断是否为常量表达式时，比如 `abs(10)`，可以直接在 planning 期间进行求值
  - `Immutable`：给定输入只会有一种输出，比如 `abs(num)`
  - `Stable`：给定输入，在同一查询内只会有一种输出，但在不同查询间可能会有不同的输出，比如 `current_time()`
  - `Volatile`：每次执行时均可能产生不同的输出，比如 `random()`

## `fn return_type_from_exprs(&self, args: &[Expr], schema: &dyn ExprSchema, arg_types: &[DataType]) -> Result<DataType>`

返回函数的返回类型。

返回类型可能是动态变化的，比如 `arrow_cast(x, 'Int16')` 和 `arrow_cast(x, 'Float32')` 会返回不同的类型。

## `fn invoke(&self, args: &[ColumnarValue]) -> Result<ColumnarValue>`

调用函数，返回执行结果。

因为是向量化执行，输入的是每个参数列的 Array（包含多行），返回结果列的 Array，行数量必须跟参数的行数量一致。

## `fn simplify(&self, args: Vec<Expr>, info: &dyn SimplifyInfo) -> Result<ExprSimplifyResult>`

根据输入参数的表达式，来进行表达式简化。

比如 `current_time()`会简化成一个字面量表达式。

## `fn short_circuits(&self) -> bool`

返回函数是否[短路](https://en.wikipedia.org/wiki/Short-circuit_evaluation)。

短路是指在求值时，只要最终的结果已经可以确定，求值过程便告终止。比如 OR 逻辑运算符，只要有一个条件为 true，就会停止后续求值。因此短路表达式对计算顺序是有要求的。

在[公共子表达式消除](https://en.wikipedia.org/wiki/Common_subexpression_elimination)优化中，如果函数是短路的，则会跳过不做优化。

比如在如下 SQL 中（已做简化，原例子参考[issue-8848](https://github.com/apache/datafusion/issues/8814)），
```sql
select 
case when a > 0 then c / a else 0 end,
case when a > 0 and b > 0 then c / a else 0 end
from t;
```
公共子表达式消除优化时，会把公共子表达式 `c / a` 提取出来提前计算，从而导致除零错误。

## `fn evaluate_bounds(&self, input: &[&Interval]) -> Result<Interval>`

根据子表达式是输入区间，计算函数的输出区间。

比如 `abs(a)` 的子表达式 `a` 的区间为 `[-3, 2]`，则输出区间为 `[0, 3]`。默认实现返回无穷的区间。

在 Filter 算子中，会根据谓词和输入算子的统计数据，计算列的边界值（min/max/distinct_count），根据前后变化计算选择率（selectivity）。

## `fn propagate_constraints(&self, interval: &Interval, inputs: &[&Interval]) -> Result<Option<Vec<Interval>>>`

根据自身的输出区间，以及子表达式的区间，重新计算子表达式的可能区间（被进一步缩小）。

比如 `abs(num)` 自身输出区间为 `[4, 5]`，而子表达式区间为 `[-7, 3]`，可以计算出子表达式只能在 `[-5, 3]` 区间内。

在 Filter 算子中，谓词的取值区间在 `[true, true]`，会以此为限制区间向下传播，更新每个子表达式的取值区间。

## `fn output_ordering(&self, inputs: &[ExprProperties]) -> Result<SortProperties>`

根据子表达式的排序属性，返回输出的排序属性。

比如 `cos(num)` 输出的排序属性是 `Unordered`，`radians(num)`（将度数转为弧度）输出的排序属性跟输入保持一致，即为 `input[0].sort_properties`。

这些排序属性会作为等价属性（EquivalenceProperties）一部分，在 Join、Sort 等优化中使用。

## `fn coerce_types(&self, arg_types: &[DataType]) -> Result<Vec<DataType>>`

对于入参类型为用户自定义类型时，在运行时拿到实际入参类型，返回需要强制转换后的入参类型。

DataFusion 会将入参强制转换为这些类型，然后再执行 UDF 的 `invoke` 方法。

比如 `make_array(expression1[, ..., expression_n])` 会找出入参类型中最大的类型，然后将每个入参强制转换为此类型。例如 `make_array(1, 2.2)` 会将每个入参转换为 `Float64` 类型。

## UDF 如何序列化和反序列化？
在分布式下，需要通过网络将执行计划传给其他节点执行，其中需要对 UDF 进行序列化和反序列化。

DataFusion 提供了两种方式对 UDF 进行序列化和反序列化
1. 只传输 UDF 名称，在反序列化时从 `FunctionRegistry` 通过名称拿到实际的 UDF，这需要 UDF 在两个节点上的 `FunctionRegistry` 均被注册
2. 用户自定义 UDF 序列化和反序列化方法

DataFusion 会优先使用用户自定义的序列化和反序列化方法，如果用户未实现，则 fallback 到使用 UDF 名称方案。

[ScalarUDFImpl]: https://docs.rs/datafusion/38.0.0/datafusion/logical_expr/trait.ScalarUDFImpl.html