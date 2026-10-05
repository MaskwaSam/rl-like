ARG NGINX_IMAGE
FROM ${NGINX_IMAGE}
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
