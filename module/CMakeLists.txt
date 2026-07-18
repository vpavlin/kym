cmake_minimum_required(VERSION 3.14)
project(KymPlugin LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")
endif()

# Module name is the single source of truth in metadata.json.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)
string(JSON MODULE_NAME GET ${METADATA_JSON} name)

# Universal UI module: the .rep view contract + one backend. The engine header
# (kym_engine.hpp) is the std-only C++ port of @kym/engine, parity-tested in
# module/test/parity.cpp.
logos_module(
    NAME ${MODULE_NAME}
    REP_FILE src/kym.rep
    SOURCES
        src/kym_backend.h
        src/kym_backend.cpp
        src/kym_engine.hpp
    INCLUDE_DIRS
        src
)
