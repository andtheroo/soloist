if(NOT TARGET oboe::oboe)
add_library(oboe::oboe SHARED IMPORTED)
set_target_properties(oboe::oboe PROPERTIES
    IMPORTED_LOCATION "C:/Users/sirle/.gradle/caches/8.14.3/transforms/c2ae37c0a1ba9cdaf907a3452300fcb4/transformed/oboe-1.9.3/prefab/modules/oboe/libs/android.armeabi-v7a/liboboe.so"
    INTERFACE_INCLUDE_DIRECTORIES "C:/Users/sirle/.gradle/caches/8.14.3/transforms/c2ae37c0a1ba9cdaf907a3452300fcb4/transformed/oboe-1.9.3/prefab/modules/oboe/include"
    INTERFACE_LINK_LIBRARIES ""
)
endif()

