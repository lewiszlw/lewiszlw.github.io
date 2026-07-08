+++
title = "开源 datafusion-remote-table 库：在远端数据库执行 SQL 查询"
date = 2025-04-01
+++

分享下最近写的一个开源库 [datafusion-remote-table]，主要用于在远端数据库执行任意 SQL 查询并将结果流式传输作为 [DataFusion] 的 一张表（ Table Provider ）。

## 功能
1. 在远端数据库执行 SQL 查询并将结果流式传输到 DataFusion 作为一张表
2. 支持下推 filters 和 limit 到远端数据库执行
3. 执行算子可以序列化反序列化以支持分布式执行
4. 数据可以被转换后再输出到下一算子

## 使用方式
```rust
#[tokio::main]
pub async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = ConnectionOptions::Postgres(PostgresConnectionOptions::new(
        "localhost",
        5432,
        "user",
        "password",
    ));
    let remote_table = RemoteTable::try_new(options, "select * from supported_data_types").await?;

    let ctx = SessionContext::new();
    ctx.register_table("remote_table", Arc::new(remote_table))?;

    ctx.sql("select * from remote_table").await?.show().await?;

    Ok(())
}
```

## 使用案例
1. 拉取远端数据源数据到本地，利用 datafusion 来进行高效的数据分析处理
2. 读取远端数据源的系统表数据，例如表的字段信息

## 支持数据库
1. Postgres
    - Int2 / Int4 / Int8
    - Float4 / Float8 / Numeric
    - Char / Varchar / Text / Bpchar / Bytea
    - Date / Time / Timestamp / Timestamptz / Interval
    - Bool / Oid / Name / Json / Jsonb / Geometry(PostGIS)
    - Int2[] / Int4[] / Int8[]
    - Float4[] / Float8[]
    - Char[] / Varchar[] / Bpchar[] / Text[] / Bytea[]
2. MySQL
    - TinyInt (Unsigned) / Smallint (Unsigned) / MediumInt (Unsigned) / Int (Unsigned) / Bigint (Unsigned)
    - Float / Double / Decimal
    - Date / DateTime / Time / Timestamp / Year
    - Char / Varchar / Binary / Varbinary
    - TinyText / Text / MediumText / LongText
    - TinyBlob / Blob / MediumBlob / LongBlob
    - Json / Geometry
3. Oracle
    - Number / BinaryFloat / BinaryDouble / Float
    - Varchar2 / NVarchar2 / Char / NChar / Long / Clob / NClob
    - Raw / Long Raw / Blob
    - Date / Timestamp
    - Boolean
4. SQLite
    - Null / Integer / Real / Text / Blob

[datafusion-remote-table]: https://github.com/systemxlabs/datafusion-remote-table
[DataFusion]: https://github.com/apache/datafusion