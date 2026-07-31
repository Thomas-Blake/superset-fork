# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
from __future__ import annotations

import io
import json
import pickle
from abc import ABC, abstractmethod
from typing import Any, TypedDict, Union
from uuid import UUID

from marshmallow import Schema, ValidationError

from superset.key_value.exceptions import (
    KeyValueCodecDecodeException,
    KeyValueCodecEncodeException,
)
from superset.utils.backports import StrEnum

Key = Union[int, UUID]


class KeyValueFilter(TypedDict, total=False):
    resource: str
    id: int | None
    uuid: UUID | None


class KeyValueResource(StrEnum):
    APP = "app"
    DASHBOARD_PERMALINK = "dashboard_permalink"
    EXPLORE_PERMALINK = "explore_permalink"
    METASTORE_CACHE = "superset_metastore_cache"
    LOCK = "lock"
    PKCE_CODE_VERIFIER = "pkce_code_verifier"
    SQLLAB_PERMALINK = "sqllab_permalink"


class SharedKey(StrEnum):
    DASHBOARD_PERMALINK_SALT = "dashboard_permalink_salt"
    EXPLORE_PERMALINK_SALT = "explore_permalink_salt"
    SQLLAB_PERMALINK_SALT = "sqllab_permalink_salt"


class KeyValueCodec(ABC):
    @abstractmethod
    def encode(self, value: Any) -> bytes: ...

    @abstractmethod
    def decode(self, value: bytes) -> Any: ...


class JsonKeyValueCodec(KeyValueCodec):
    def encode(self, value: dict[Any, Any]) -> bytes:
        try:
            return bytes(json.dumps(value), encoding="utf-8")
        except TypeError as ex:
            raise KeyValueCodecEncodeException(str(ex)) from ex

    def decode(self, value: bytes) -> dict[Any, Any]:
        try:
            return json.loads(value)
        except TypeError as ex:
            raise KeyValueCodecDecodeException(str(ex)) from ex


class _RestrictedUnpickler(pickle.Unpickler):
    """
    Restricted ``pickle.Unpickler`` that only allows reconstructing a known-safe
    set of classes.

    The default :func:`pickle.loads` is unsafe to use on untrusted input because
    it can construct arbitrary objects and invoke arbitrary callables, which is
    a well-known remote code execution vector. By overriding ``find_class`` we
    constrain the classes that can be referenced by a pickle stream to a small
    allow-list of immutable / container types from the standard library.

    Primitive built-in types (``int``, ``float``, ``str``, ``bytes``, ``bool``,
    ``None``, ``list``, ``dict``, ``tuple``) are reconstructed via dedicated
    pickle opcodes and never go through ``find_class``, so they remain
    supported without being listed here.
    """

    _SAFE_CLASSES: dict[str, frozenset[str]] = {
        "builtins": frozenset({"complex", "frozenset", "set"}),
        "collections": frozenset({"OrderedDict", "defaultdict"}),
        "datetime": frozenset({"date", "datetime", "time", "timedelta", "timezone"}),
        "uuid": frozenset({"UUID"}),
    }

    def find_class(self, module: str, name: str) -> Any:
        if name in self._SAFE_CLASSES.get(module, frozenset()):
            return super().find_class(module, name)
        raise pickle.UnpicklingError(
            f"Refusing to unpickle disallowed global '{module}.{name}'"
        )


class PickleKeyValueCodec(KeyValueCodec):
    def encode(self, value: dict[Any, Any]) -> bytes:
        return pickle.dumps(value)

    def decode(self, value: bytes) -> dict[Any, Any]:
        try:
            return _RestrictedUnpickler(io.BytesIO(value)).load()
        except (pickle.UnpicklingError, AttributeError, EOFError, ImportError) as ex:
            raise KeyValueCodecDecodeException(str(ex)) from ex


class MarshmallowKeyValueCodec(JsonKeyValueCodec):
    def __init__(self, schema: Schema):
        self.schema = schema

    def encode(self, value: dict[Any, Any]) -> bytes:
        try:
            obj = self.schema.dump(value)
            return super().encode(obj)
        except ValidationError as ex:
            raise KeyValueCodecEncodeException(message=str(ex)) from ex

    def decode(self, value: bytes) -> dict[Any, Any]:
        try:
            obj = super().decode(value)
            return self.schema.load(obj)
        except ValidationError as ex:
            raise KeyValueCodecEncodeException(message=str(ex)) from ex
